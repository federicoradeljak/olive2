"""Reconciles estimated Modal transcription spend with Modal's hourly billing.

``usage_events`` keeps the per-run *estimate* (GPU seconds x rate card) and is
never modified here: every total that existed before keeps its meaning. The
billed cost Modal reports per hour for the GPU app is stored apart
(``modal_billing_hours``) and split across that hour's Modal transcriptions by
GPU seconds (``modal_billed_events``), so the UI can show it next to the
estimate. Dropping both tables restores the previous behaviour exactly.
"""

from __future__ import annotations

import json
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from ..db import DbHandle
from ..providers.modal.billing import ModalBillingHour
from .usage import _engine_of

HOUR_MS = 3_600_000
# Modal revises recent hours for a while; every sync re-fetches this window.
WINDOW_HOURS = 48
STATUS_KEY = "modal_billing_status"
SYNC_DEDUP_ID = "modal-billing"

Fetcher = Callable[[datetime, datetime], Awaitable[list[ModalBillingHour]]]

CREATE_MODAL_BILLING_SQL = [
    """CREATE TABLE IF NOT EXISTS modal_billing_hours (
    hour_start INTEGER PRIMARY KEY,
    app_name TEXT NOT NULL,
    cost_usd REAL NOT NULL,
    cost_by_resource TEXT,
    fetched_at INTEGER NOT NULL
)""",
    """CREATE TABLE IF NOT EXISTS modal_billed_events (
    usage_event_id TEXT NOT NULL,
    hour_start INTEGER NOT NULL,
    billed_usd REAL NOT NULL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (usage_event_id, hour_start)
)""",
    "CREATE INDEX IF NOT EXISTS idx_modal_billed_events_hour ON modal_billed_events(hour_start)",
]


def ensure_modal_billing_tables(db: Engine | DbHandle | None = None) -> None:
    with _engine_of(db).begin() as conn:
        for stmt in CREATE_MODAL_BILLING_SQL:
            conn.execute(text(stmt))


def _dt(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=UTC)


def _read_status(conn: Connection) -> dict[str, Any] | None:
    row = conn.execute(text("SELECT value FROM sync_state WHERE key = :k"), {"k": STATUS_KEY}).first()
    if row is None:
        return None
    try:
        value = json.loads(row[0])
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _write_status(conn: Connection, status: dict[str, Any]) -> None:
    conn.execute(
        text("INSERT INTO sync_state (key, value) VALUES (:k, :v) ON CONFLICT(key) DO UPDATE SET value = :v"),
        {"k": STATUS_KEY, "v": json.dumps(status)},
    )


def _gpu_seconds(detail: Any) -> float:
    try:
        value = float((json.loads(detail) if detail else {}).get("gpuSeconds") or 0.0)
    except (TypeError, ValueError, AttributeError):
        return 0.0
    return value if value > 0 else 0.0


def _attribute(
    conn: Connection, hours: list[ModalBillingHour], start_ms: int, end_ms: int, now_ms: int
) -> int:
    """Splits each billed hour over its Modal runs; returns the rows written.

    An hour with cost but no run (the container idling out after the last
    call) is charged to the previous hour's runs; with none there either it
    stays unattributed and only counts in the hourly totals.
    """
    rows = conn.execute(
        text(
            """
            SELECT id, created_at, detail FROM usage_events
            WHERE kind = 'transcription' AND provider = 'modal'
              AND created_at >= :start AND created_at < :end
            """
        ),
        {"start": start_ms - HOUR_MS, "end": end_ms},
    ).all()
    runs: dict[int, list[tuple[str, float]]] = defaultdict(list)
    for event_id, created_at, detail in rows:
        hour = int(created_at) - int(created_at) % HOUR_MS
        runs[hour].append((str(event_id), _gpu_seconds(detail)))

    conn.execute(
        text("DELETE FROM modal_billed_events WHERE hour_start >= :start AND hour_start < :end"),
        {"start": start_ms, "end": end_ms},
    )
    written = 0
    for hour in hours:
        targets = runs.get(hour.hour_start_ms) or runs.get(hour.hour_start_ms - HOUR_MS)
        if not targets or hour.cost_usd <= 0:
            continue
        total = sum(seconds for _, seconds in targets)
        for event_id, seconds in targets:
            share = seconds / total if total > 0 else 1 / len(targets)
            conn.execute(
                text(
                    """
                    INSERT INTO modal_billed_events (usage_event_id, hour_start, billed_usd, computed_at)
                    VALUES (:eid, :hour, :usd, :now)
                    """
                ),
                {
                    "eid": event_id,
                    "hour": hour.hour_start_ms,
                    "usd": round(hour.cost_usd * share, 8),
                    "now": now_ms,
                },
            )
            written += 1
    return written


async def reconcile_modal_billing(
    db: Engine | DbHandle | None,
    fetch: Fetcher,
    *,
    app_name: str,
    now_ms: int | None = None,
    window_hours: int = WINDOW_HOURS,
) -> dict[str, Any]:
    """Fetches the last ``window_hours`` complete hours and re-splits them."""
    ensure_modal_billing_tables(db)
    engine = _engine_of(db)
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    end_ms = now - now % HOUR_MS
    start_ms = end_ms - window_hours * HOUR_MS
    with engine.connect() as conn:
        status = _read_status(conn) or {}
    status["lastAttemptAt"] = now
    try:
        fetched = await fetch(_dt(start_ms), _dt(end_ms))
    except Exception as exc:
        status["lastError"] = str(exc) or type(exc).__name__
        with engine.begin() as conn:
            _write_status(conn, status)
        return {"status": "error", "error": status["lastError"]}

    hours = [h for h in fetched if start_ms <= h.hour_start_ms < end_ms]
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM modal_billing_hours WHERE hour_start >= :start AND hour_start < :end"),
            {"start": start_ms, "end": end_ms},
        )
        for hour in hours:
            conn.execute(
                text(
                    """
                    INSERT INTO modal_billing_hours (hour_start, app_name, cost_usd, cost_by_resource, fetched_at)
                    VALUES (:hour, :app, :cost, :res, :now)
                    """
                ),
                {
                    "hour": hour.hour_start_ms,
                    "app": app_name,
                    "cost": hour.cost_usd,
                    "res": json.dumps(hour.cost_by_resource),
                    "now": now,
                },
            )
        attributed = _attribute(conn, hours, start_ms, end_ms, now)
        status.update({"lastSyncedAt": now, "lastError": None})
        _write_status(conn, status)
    return {"status": "ok", "hours": len(hours), "attributedRows": attributed}


def billed_usd_by_event_sql() -> str:
    """Subquery of billed USD per usage event, for ``LEFT JOIN`` on ``u.id``."""
    return "SELECT usage_event_id, SUM(billed_usd) AS billed_usd FROM modal_billed_events GROUP BY usage_event_id"


def get_modal_billing_summary(
    conn: Connection, start_ms: int | None = None, end_ms: int | None = None
) -> dict[str, Any] | None:
    """Billed vs estimated Modal spend for a range; ``None`` before the first sync."""
    status = _read_status(conn)
    if status is None:
        return None
    params = {
        "start": start_ms if start_ms is not None else 0,
        "end": end_ms if end_ms is not None else 2**62,
    }
    billed = conn.execute(
        text(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM modal_billing_hours WHERE hour_start >= :start AND hour_start < :end"
        ),
        params,
    ).scalar_one()
    attributed = conn.execute(
        text(
            "SELECT COALESCE(SUM(billed_usd), 0) FROM modal_billed_events WHERE hour_start >= :start AND hour_start < :end"
        ),
        params,
    ).scalar_one()
    events = (
        conn.execute(
            text(
                f"""
                SELECT
                  COALESCE(SUM(CASE WHEN b.usage_event_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS reconciled,
                  COALESCE(SUM(CASE WHEN b.usage_event_id IS NULL THEN 1 ELSE 0 END), 0) AS pending,
                  COALESCE(SUM(CASE WHEN b.usage_event_id IS NOT NULL THEN u.cost_usd ELSE 0 END), 0) AS est
                FROM usage_events u
                LEFT JOIN ({billed_usd_by_event_sql()}) b ON b.usage_event_id = u.id
                WHERE u.kind = 'transcription' AND u.provider = 'modal'
                  AND u.created_at >= :start AND u.created_at < :end
                """
            ),
            params,
        )
        .mappings()
        .one()
    )
    return {
        "billedUsd": round(float(billed), 6),
        "attributedUsd": round(float(attributed), 6),
        "unattributedUsd": round(max(float(billed) - float(attributed), 0.0), 6),
        "reconciledEvents": int(events["reconciled"]),
        "pendingEvents": int(events["pending"]),
        "estimatedReconciledUsd": round(float(events["est"]), 6),
        "lastSyncedAt": status.get("lastSyncedAt"),
        "lastAttemptAt": status.get("lastAttemptAt"),
        "lastError": status.get("lastError"),
    }


async def sync_modal_billing(db: Engine | DbHandle | None, modal_client: Any) -> dict[str, Any]:
    """Queue job body: reconciles with the credentials ``modal_client`` holds."""
    from ..providers.modal.billing import fetch_hourly_app_costs

    token_id = str(getattr(modal_client, "token_id", "") or "").strip()
    token_secret = str(getattr(modal_client, "token_secret", "") or "").strip()
    if not (token_id and token_secret):
        return {"status": "skipped"}
    app_name = str(modal_client.app_name)

    async def fetch(start: datetime, end: datetime) -> list[ModalBillingHour]:
        return await fetch_hourly_app_costs(token_id, token_secret, app_name, start, end)

    return await reconcile_modal_billing(db, fetch, app_name=app_name)


async def enqueue_modal_billing_sync(db: Engine | DbHandle | None, modal_client: Any) -> bool:
    """Queues a sync on ``modal_billing``; ``False`` when one is already queued."""
    from dbos._error import DBOSQueueDeduplicatedError

    from ..workflows import QUEUE_MODAL_BILLING, enqueue_stage_job

    try:
        await enqueue_stage_job(
            QUEUE_MODAL_BILLING,
            lambda: sync_modal_billing(db, modal_client),
            deduplication_id=SYNC_DEDUP_ID,
            label="modal-billing",
        )
    except DBOSQueueDeduplicatedError:
        return False
    return True
