"""Modal billing reconciliation tests (fake fetcher, in-memory DB)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import text

from olive.db import create_db
from olive.providers.modal.billing import ModalBillingHour, aggregate_app_hours
from olive.services.modal_billing import HOUR_MS, reconcile_modal_billing
from olive.services.usage import get_meeting_usage, get_usage_summary, record_transcription_usage

# 2026-10-28 18:00 UTC, an hour boundary.
H18 = 1_793_210_400_000
NOW = H18 + 3 * HOUR_MS + 5 * 60_000  # 21:05, so 18-20 are complete hours.


def _seed_meeting(handle: Any, meeting_id: str) -> None:
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (:id, 'Billing Fixture', :t, :t, 'upload', 'ready', '[]', NULL, NULL, NULL, :t, :t)
                """
            ),
            {"id": meeting_id, "t": H18},
        )


def _modal_run(
    handle: Any, meeting_id: str | None, at: int, gpu_seconds: float, estimate: float, call: str
) -> None:
    record_transcription_usage(
        handle.engine,
        meeting_id=meeting_id,
        provider="modal",
        audio_seconds=600.0,
        created_at=at,
        source=f"modal:{call}",
        model="cohere",
        cost_usd=estimate,
        detail={"gpu": "A10G", "gpuSeconds": gpu_seconds, "functionCallId": call},
    )


def _fetcher(hours: list[ModalBillingHour], calls: list[tuple[datetime, datetime]] | None = None) -> Any:
    async def fetch(start: datetime, end: datetime) -> list[ModalBillingHour]:
        if calls is not None:
            calls.append((start, end))
        lo, hi = start.timestamp() * 1000, end.timestamp() * 1000
        return [h for h in hours if lo <= h.hour_start_ms < hi]

    return fetch


def _billed(handle: Any) -> dict[str, float]:
    with handle.engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT e.source, SUM(b.billed_usd) FROM modal_billed_events b "
                "JOIN usage_events e ON e.id = b.usage_event_id GROUP BY e.source"
            )
        ).all()
    return {source: usd for source, usd in rows}


def test_aggregate_app_hours_sums_every_deploy_of_the_app() -> None:
    def item(app: str, hour: datetime, cost: str, resources: dict[str, str]) -> Any:
        return SimpleNamespace(description=app, interval_start=hour, cost=cost, cost_by_resource=resources)

    h = datetime(2026, 10, 28, 18, tzinfo=UTC)
    rows = aggregate_app_hours(
        [
            item("olive-gpu", h, "0.10", {"A10G": "0.09", "CPU": "0.01"}),
            item("olive-gpu", h, "0.05", {"T4": "0.05"}),  # a second App id (redeploy)
            item("other-app", h, "9.99", {"CPU": "9.99"}),
        ],
        "olive-gpu",
    )
    assert rows == [
        ModalBillingHour(
            hour_start_ms=H18, cost_usd=0.15, cost_by_resource={"A10G": 0.09, "CPU": 0.01, "T4": 0.05}
        )
    ]


async def test_reconcile_splits_hour_by_gpu_seconds_and_carries_idle_hours() -> None:
    handle = create_db(":memory:")
    _modal_run(handle, None, H18 + 10 * 60_000, 100.0, 0.03, "a")
    _modal_run(handle, None, H18 + 40 * 60_000, 300.0, 0.09, "b")
    hours = [
        ModalBillingHour(H18, 0.20),
        # Container idled out after the 18:40 run: no run at 19:xx.
        ModalBillingHour(H18 + HOUR_MS, 0.04),
        # Nothing in the hour before either: stays unattributed.
        ModalBillingHour(H18 - 5 * HOUR_MS, 0.07),
    ]
    calls: list[tuple[datetime, datetime]] = []
    result = await reconcile_modal_billing(
        handle.engine, _fetcher(hours, calls), app_name="olive-gpu", now_ms=NOW
    )

    assert result["status"] == "ok"
    # First sync backfills from the start of the previous month, in <= 7-day chunks.
    assert calls[0][0] == datetime(2026, 9, 1, tzinfo=UTC)
    assert calls[-1][1] == datetime(2026, 10, 28, 21, tzinfo=UTC)
    assert all(b - a <= timedelta(days=7) for a, b in calls)
    assert all(prev[1] == cur[0] for prev, cur in zip(calls, calls[1:], strict=False))
    billed = _billed(handle)
    assert billed["modal:a"] == pytest.approx(0.06)  # 1/4 of (0.20 + 0.04)
    assert billed["modal:b"] == pytest.approx(0.18)

    with handle.engine.connect() as conn:
        from olive.services.modal_billing import get_modal_billing_summary

        block = get_modal_billing_summary(conn)
    assert block is not None
    assert block["billedUsd"] == pytest.approx(0.31)
    assert block["attributedUsd"] == pytest.approx(0.24)
    assert block["unattributedUsd"] == pytest.approx(0.07)
    assert block["reconciledEvents"] == 2
    assert block["pendingEvents"] == 0
    assert block["estimatedReconciledUsd"] == pytest.approx(0.12)
    assert block["lastSyncedAt"] == NOW
    assert block["lastError"] is None
    assert block["coveredFrom"] == int(datetime(2026, 9, 1, tzinfo=UTC).timestamp() * 1000)
    handle.engine.dispose()


async def test_reconcile_is_idempotent_and_follows_revised_hours() -> None:
    handle = create_db(":memory:")
    _modal_run(handle, None, H18 + 60_000, 50.0, 0.01, "a")
    fetch = _fetcher([ModalBillingHour(H18, 0.10)])
    await reconcile_modal_billing(handle.engine, fetch, app_name="olive-gpu", now_ms=NOW)
    await reconcile_modal_billing(handle.engine, fetch, app_name="olive-gpu", now_ms=NOW)
    assert _billed(handle) == {"modal:a": pytest.approx(0.10)}

    # Modal revises the hour later: the next sync replaces, never adds.
    await reconcile_modal_billing(
        handle.engine, _fetcher([ModalBillingHour(H18, 0.12)]), app_name="olive-gpu", now_ms=NOW + HOUR_MS
    )
    assert _billed(handle) == {"modal:a": pytest.approx(0.12)}
    handle.engine.dispose()


async def test_runs_without_gpu_seconds_split_evenly() -> None:
    handle = create_db(":memory:")
    _modal_run(handle, None, H18 + 60_000, 0.0, 0.0, "a")
    _modal_run(handle, None, H18 + 120_000, 0.0, 0.0, "b")
    await reconcile_modal_billing(
        handle.engine, _fetcher([ModalBillingHour(H18, 0.10)]), app_name="olive-gpu", now_ms=NOW
    )
    assert _billed(handle) == {"modal:a": pytest.approx(0.05), "modal:b": pytest.approx(0.05)}
    handle.engine.dispose()


async def test_fetch_error_is_recorded_and_keeps_previous_sync() -> None:
    handle = create_db(":memory:")
    _modal_run(handle, None, H18 + 60_000, 50.0, 0.01, "a")
    await reconcile_modal_billing(
        handle.engine, _fetcher([ModalBillingHour(H18, 0.10)]), app_name="olive-gpu", now_ms=NOW
    )

    async def failing(start: datetime, end: datetime) -> list[ModalBillingHour]:
        raise PermissionError("billing not available on this plan")

    later = NOW + HOUR_MS
    result = await reconcile_modal_billing(handle.engine, failing, app_name="olive-gpu", now_ms=later)
    assert result == {"status": "error", "error": "billing not available on this plan"}
    assert _billed(handle) == {"modal:a": pytest.approx(0.10)}
    block = get_usage_summary(handle.engine)["modalBilling"]
    assert block["lastSyncedAt"] == NOW
    assert block["lastAttemptAt"] == later
    assert block["lastError"] == "billing not available on this plan"
    handle.engine.dispose()


async def test_existing_usage_figures_are_unchanged_by_reconciliation() -> None:
    handle = create_db(":memory:")
    _seed_meeting(handle, "m1")
    _modal_run(handle, "m1", H18 + 60_000, 100.0, 0.03, "a")
    record_transcription_usage(
        handle.engine,
        meeting_id="m1",
        provider="assemblyai",
        audio_seconds=3600.0,
        created_at=H18,
        source="aai:1",
    )
    with handle.engine.connect() as conn:
        rows_before = conn.execute(text("SELECT * FROM usage_events ORDER BY id")).all()
    summary_before = get_usage_summary(handle.engine)
    meeting_before = get_meeting_usage(handle.engine, "m1")
    assert "modalBilling" not in summary_before

    await reconcile_modal_billing(
        handle.engine, _fetcher([ModalBillingHour(H18, 0.20)]), app_name="olive-gpu", now_ms=NOW
    )

    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM usage_events ORDER BY id")).all() == rows_before
    summary_after = get_usage_summary(handle.engine)
    meeting_after = get_meeting_usage(handle.engine, "m1")

    # Every pre-existing field keeps its value; only new keys appear.
    for key, value in summary_before.items():
        if key not in ("byMeeting",):
            assert summary_after[key] == value, key
    [m_before] = summary_before["byMeeting"]
    [m_after] = summary_after["byMeeting"]
    assert {k: m_after[k] for k in m_before} == m_before
    assert m_after["modalBilledUsd"] == pytest.approx(0.20)
    assert summary_after["modalBilling"]["billedUsd"] == pytest.approx(0.20)

    assert {k: v for k, v in meeting_after.items() if k != "events"} == {
        k: v for k, v in meeting_before.items() if k != "events"
    }
    for before, after in zip(meeting_before["events"], meeting_after["events"], strict=True):
        assert {k: after[k] for k in before} == before
    billed_events = [e for e in meeting_after["events"] if "billedCostUsd" in e]
    assert [e["provider"] for e in billed_events] == ["modal"]
    assert billed_events[0]["billedCostUsd"] == pytest.approx(0.20)
    handle.engine.dispose()


async def test_summary_range_only_counts_its_own_hours() -> None:
    handle = create_db(":memory:")
    _modal_run(handle, None, H18 + 60_000, 10.0, 0.01, "a")
    await reconcile_modal_billing(
        handle.engine,
        _fetcher([ModalBillingHour(H18, 0.10), ModalBillingHour(H18 + 2 * HOUR_MS, 0.05)]),
        app_name="olive-gpu",
        now_ms=NOW,
    )
    block = get_usage_summary(handle.engine, start_ms=H18 + HOUR_MS, end_ms=H18 + 3 * HOUR_MS)["modalBilling"]
    assert block["billedUsd"] == pytest.approx(0.05)
    assert block["attributedUsd"] == 0
    assert block["reconciledEvents"] == 0
    handle.engine.dispose()


def test_reconcile_route_requires_token_and_enqueues(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi.testclient import TestClient

    from olive.app import create_app
    from olive.providers.modal import ModalClient
    from olive.services import modal_billing

    handle = create_db(":memory:")
    modal_client = ModalClient(tokenId="", tokenSecret="")
    app = create_app(
        {"db": handle.engine, "meetingsDir": str(tmp_path / "meetings"), "modalClient": modal_client}
    )
    client = TestClient(app)
    assert client.post("/api/usage/modal/reconcile").status_code == 400

    queued: list[Any] = []

    async def fake_enqueue(db: Any, c: Any) -> bool:
        queued.append(c)
        return len(queued) == 1

    monkeypatch.setattr(modal_billing, "enqueue_modal_billing_sync", fake_enqueue)
    modal_client.set_credentials("ak-id", "as-secret")
    res = client.post("/api/usage/modal/reconcile")
    assert (res.status_code, res.json()) == (202, {"status": "queued"})
    assert client.post("/api/usage/modal/reconcile").json() == {"status": "already_queued"}
    assert queued == [modal_client, modal_client]
    handle.engine.dispose()


async def test_sync_after_long_downtime_fills_the_gap() -> None:
    handle = create_db(":memory:")
    await reconcile_modal_billing(handle.engine, _fetcher([]), app_name="olive-gpu", now_ms=NOW)

    # Olive was down for 10 days; a run happened 5 days after the last sync.
    later_run = H18 + 5 * 24 * HOUR_MS
    _modal_run(handle, None, later_run + 60_000, 10.0, 0.01, "a")
    calls: list[tuple[datetime, datetime]] = []
    await reconcile_modal_billing(
        handle.engine,
        _fetcher([ModalBillingHour(later_run, 0.30)], calls),
        app_name="olive-gpu",
        now_ms=NOW + 10 * 24 * HOUR_MS,
    )
    # Resumes 48 h before the previously covered hour (21:00), never skipping.
    assert calls[0][0] == datetime(2026, 10, 26, 21, tzinfo=UTC)
    assert calls[-1][1] == datetime(2026, 11, 7, 21, tzinfo=UTC)
    assert _billed(handle) == {"modal:a": pytest.approx(0.30)}
    handle.engine.dispose()
