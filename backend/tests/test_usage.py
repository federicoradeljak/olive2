"""API spend / usage tracking tests."""

from __future__ import annotations

import inspect
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.services.chat import ChatService
from olive.services.llm import LlmService
from olive.services.transcription import TranscriptionService
from olive.services.usage import (
    backfill_usage_events,
    current_month_str,
    estimate_llm_cost,
    estimate_transcription_cost,
    get_meeting_usage,
    get_usage_summary,
    month_bounds_ms,
    record_llm_usage,
    record_transcription_usage,
)


def test_estimate_llm_cost_uses_catalog_rates() -> None:
    # gemini-2.5-flash: $0.15 / $0.60 per 1M tokens.
    assert estimate_llm_cost("google", "gemini-2.5-flash", 1_000_000, 1_000_000) == 0.75
    assert estimate_llm_cost("google", "gemini-2.5-flash", 0, 0) is None
    assert estimate_llm_cost("google", "no-such-model", 100, 100) is None
    assert estimate_llm_cost(None, "gemini-2.5-flash", 100, 100) is None


def test_estimate_transcription_cost_uses_hourly_rates() -> None:
    assert estimate_transcription_cost("assemblyai", 3600.0) == 0.23
    assert estimate_transcription_cost("speechmatics", 1800.0) == 0.225
    assert estimate_transcription_cost("local", 3600.0) == 0.0
    assert estimate_transcription_cost("unknown-provider", 3600.0) is None
    assert estimate_transcription_cost("assemblyai", None) is None


def test_month_bounds_rejects_bad_input() -> None:
    start, end = month_bounds_ms("2026-10")
    assert end - start > 28 * 24 * 3600 * 1000
    assert start < end
    for bad in ("october", "2026-13", "2026-1", "", "2026/10"):
        try:
            month_bounds_ms(bad)
        except ValueError:
            pass
        else:
            raise AssertionError(f"expected ValueError for {bad!r}")
    assert len(current_month_str().split("-")) == 2


def _seed_meeting(handle: Any, meeting_id: str, now: int, duration_ms: int = 3_600_000) -> None:
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Usage Fixture', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + duration_ms},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  :rid, :mid, 'audio/test.m4a', 'audio/mp4', :dur, 100,
                  :sha, 'upload', NULL, :now
                )
                """
            ),
            {
                "rid": f"rec-{meeting_id}",
                "mid": meeting_id,
                "dur": duration_ms,
                "sha": f"sha-{meeting_id}",
                "now": now,
            },
        )


def test_record_and_summarize_usage() -> None:
    handle = create_db(":memory:")
    now = int(time.time() * 1000)
    _seed_meeting(handle, "m-usage-1", now)

    record_transcription_usage(
        handle.engine,
        meeting_id="m-usage-1",
        provider="assemblyai",
        recording_id="rec-m-usage-1",
        created_at=now,
        source="transcript:art-1",
    )
    record_llm_usage(
        handle.engine,
        meeting_id="m-usage-1",
        kind="summary",
        provider="google",
        model="gemini-2.5-flash",
        input_tokens=1_000_000,
        output_tokens=1_000_000,
        created_at=now,
        source="summary:art-2",
    )
    # Idempotent: same source keys are ignored.
    record_transcription_usage(
        handle.engine,
        meeting_id="m-usage-1",
        provider="assemblyai",
        recording_id="rec-m-usage-1",
        created_at=now,
        source="transcript:art-1",
    )

    summary = get_usage_summary(handle.engine)
    assert summary["eventCount"] == 2
    assert summary["audioSeconds"] == 3600.0
    assert summary["transcriptionCostUsd"] == 0.23
    assert summary["totalTokens"] == 2_000_000
    assert summary["llmCostUsd"] == 0.75
    assert summary["totalCostUsd"] == 0.98
    assert {p["provider"] for p in summary["byProvider"]} == {"assemblyai", "google"}
    assert len(summary["byMeeting"]) == 1
    assert summary["byMeeting"][0]["meetingId"] == "m-usage-1"
    assert summary["byMeeting"][0]["totalCostUsd"] == 0.98
    assert summary["rates"]["transcriptionUsdPerHour"]["assemblyai"] == 0.23

    meeting = get_meeting_usage(handle.engine, "m-usage-1")
    assert meeting["eventCount"] == 2
    assert meeting["totalCostUsd"] == 0.98
    assert len(meeting["events"]) == 2
    handle.engine.dispose()


def test_backfill_covers_legacy_chat_and_transcripts() -> None:
    handle = create_db(":memory:")
    now = int(time.time() * 1000)
    _seed_meeting(handle, "m-backfill-1", now, duration_ms=1_800_000)
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO chat_messages (
                  id, meeting_id, role, content, provider, model, usage, created_at
                ) VALUES (
                  'msg-1', :mid, 'assistant', 'hello', 'google', 'gemini-2.5-flash',
                  :usage, :now
                )
                """
            ),
            {
                "mid": "m-backfill-1",
                "usage": json.dumps({"inputTokens": 1000, "outputTokens": 500, "totalTokens": 1500}),
                "now": now,
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES (
                  'art-tx-1', :mid, :rid, 'transcript', 'speechmatics', 'json',
                  'transcripts/speechmatics.json', :now
                )
                """
            ),
            {"mid": "m-backfill-1", "rid": "rec-m-backfill-1", "now": now},
        )

    first = backfill_usage_events(handle.engine)
    assert first["chat"] == 1
    assert first["transcription"] == 1
    second = backfill_usage_events(handle.engine)
    assert second["skipped"] is True

    summary = get_usage_summary(handle.engine)
    assert summary["eventCount"] == 2
    # 1000 * 0.15/1M + 500 * 0.60/1M = 0.00045 ; speechmatics 0.5h * 0.45 = 0.225
    assert summary["llmCostUsd"] == 0.00045
    assert summary["transcriptionCostUsd"] == 0.225
    handle.engine.dispose()


def test_usage_api_routes(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    now = int(time.time() * 1000)
    _seed_meeting(handle, "m-api-1", now)
    record_transcription_usage(
        handle.engine,
        meeting_id="m-api-1",
        provider="local",
        recording_id="rec-m-api-1",
        created_at=now,
        source="transcript:art-local-1",
    )
    app = create_app({"db": handle.engine, "meetingsDir": str(tmp_path / "meetings")})
    client = TestClient(app)

    res = client.get("/api/usage/summary", params={"period": "all"})
    assert res.status_code == 200
    body = res.json()
    assert body["eventCount"] == 1
    assert body["transcriptionCostUsd"] == 0.0
    assert body["byMeeting"][0]["meetingId"] == "m-api-1"

    res = client.get("/api/usage/summary", params={"month": current_month_str()})
    assert res.status_code == 200
    assert res.json()["eventCount"] == 1

    res = client.get("/api/usage/summary", params={"month": "not-a-month"})
    assert res.status_code == 400

    res = client.get("/api/meetings/m-api-1/usage")
    assert res.status_code == 200
    assert res.json()["eventCount"] == 1

    res = client.get("/api/meetings/does-not-exist/usage")
    assert res.status_code == 404
    handle.engine.dispose()


def test_chat_hook_records_usage_with_cost(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    now = int(time.time() * 1000)
    _seed_meeting(handle, "m-chat-hook", now)
    llm_service = LlmService(db=handle.engine, config_dir=str(tmp_path / "config"))

    async def fake_stream_text(options: dict[str, Any], on_delta: Callable[[str], Any]) -> dict[str, Any]:
        res = on_delta("hi")
        if inspect.isawaitable(res):
            await res
        return {
            "text": "hi",
            "provider": "google",
            "model": "gemini-2.5-flash",
            "durationMs": 1,
            "usage": {"inputTokens": 1_000_000, "outputTokens": 0, "totalTokens": 1_000_000},
        }

    llm_service.stream_text = fake_stream_text  # type: ignore[method-assign]
    llm_service.streamText = fake_stream_text  # type: ignore[assignment]
    chat_service = ChatService(
        db=handle.engine, meetings_dir=str(tmp_path / "meetings"), llm_service=llm_service
    )
    app = create_app(
        {"db": handle.engine, "meetingsDir": str(tmp_path / "meetings"), "chatService": chat_service}
    )
    client = TestClient(app)

    res = client.post(
        "/api/meetings/m-chat-hook/chat/messages",
        headers={"accept": "text/event-stream"},
        json={"content": "hello"},
    )
    assert res.status_code == 200

    with handle.engine.connect() as conn:
        row = conn.execute(
            text("SELECT usage FROM chat_messages WHERE meeting_id = :mid AND role = 'assistant'"),
            {"mid": "m-chat-hook"},
        ).first()
        assert row is not None
        assert json.loads(row[0])["cost"] == 0.15
        events = conn.execute(text("SELECT kind, cost_usd FROM usage_events")).mappings().all()
    assert len(events) == 1
    assert events[0]["kind"] == "chat"
    assert events[0]["cost_usd"] == 0.15
    handle.engine.dispose()


def test_transcription_artifact_hook_records_usage(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    now = int(time.time() * 1000)
    _seed_meeting(handle, "m-tx-hook", now, duration_ms=3_600_000)
    meetings_dir = str(tmp_path / "meetings")
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "speechmaticsClient": object(),
            "assemblyaiClient": object(),
            "now": lambda: now,
        }
    )

    async def _run() -> str:
        return await service._ensure_artifact(
            "m-tx-hook",
            "rec-m-tx-hook",
            "transcript",
            "json",
            "transcripts/assemblyai.json",
            json.dumps({"segments": [], "durationMs": 3_600_000}),
            str(tmp_path / "meetings" / "m" / "transcripts"),
            "assemblyai",
        )

    import asyncio

    art_id = asyncio.run(_run())
    art_id_again = asyncio.run(_run())
    assert art_id == art_id_again

    with handle.engine.connect() as conn:
        events = conn.execute(text("SELECT * FROM usage_events")).mappings().all()
    assert len(events) == 1
    assert events[0]["kind"] == "transcription"
    assert events[0]["provider"] == "assemblyai"
    assert events[0]["cost_usd"] == 0.23
    handle.engine.dispose()
