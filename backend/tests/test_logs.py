"""Database logging and Logs API tests (port of logs.test.ts)."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.logging_db import logger, set_log_database


def test_writes_structured_logs_to_sqlite() -> None:
    handle = create_db(":memory:")
    set_log_database(handle)

    now = 1_700_000_000_000
    meeting_id = "11111111-2222-3333-4444-555555555555"

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Test Ingest Meeting', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 60_000},
        )

    logger.debug(
        "Received audio upload payload",
        {"category": "ingest", "meetingId": meeting_id, "sizeBytes": 1024, "mime": "audio/wav"},
    )
    logger.info(
        "Ingest completed successfully",
        {"category": "ingest", "meetingId": meeting_id, "recordingId": "rec-1"},
    )
    logger.warn(
        "Speechmatics transcription warning",
        {"category": "transcription", "meetingId": meeting_id, "code": "low_confidence"},
    )
    logger.error(
        "LLM quota exceeded",
        {"category": "llm", "provider": "google", "error": "RATE_LIMIT_EXCEEDED"},
    )

    with handle.engine.connect() as conn:
        rows = conn.execute(text("SELECT * FROM logs")).mappings().all()
    assert len(rows) == 4

    debug_row = next(r for r in rows if r["level"] == "debug")
    assert debug_row["category"] == "ingest"
    assert debug_row["message"] == "Received audio upload payload"
    assert debug_row["meeting_id"] == meeting_id
    assert json.loads(debug_row["details"] or "{}") == {"sizeBytes": 1024, "mime": "audio/wav"}

    set_log_database(None)
    handle.engine.dispose()


def test_logs_api_filtering_search_pagination_and_delete() -> None:
    handle = create_db(":memory:")
    set_log_database(handle)

    logger.debug("Debug step A", {"category": "ingest", "step": 1})
    logger.debug("Debug step B", {"category": "transcription", "step": 2})
    logger.info("Info step C", {"category": "transcription", "step": 3})
    logger.warn("Warn step D", {"category": "summary", "step": 4})
    logger.error("Error step E", {"category": "summary", "step": 5})

    app = create_app({"db": handle.engine})
    client = TestClient(app)

    all_res = client.get("/api/logs?level=debug")
    assert all_res.status_code == 200
    all_data = all_res.json()
    assert all_data["ok"] is True
    assert len(all_data["logs"]) == 5
    assert "ingest" in all_data["categories"]
    assert "transcription" in all_data["categories"]
    assert "summary" in all_data["categories"]

    info_data = client.get("/api/logs?level=info").json()
    assert len(info_data["logs"]) == 3
    assert all(item["level"] in ("info", "warn", "error") for item in info_data["logs"])

    warn_data = client.get("/api/logs?level=warn").json()
    assert len(warn_data["logs"]) == 2

    error_data = client.get("/api/logs?level=error").json()
    assert len(error_data["logs"]) == 1
    assert error_data["logs"][0]["message"] == "Error step E"

    cat_data = client.get("/api/logs?category=transcription").json()
    assert len(cat_data["logs"]) == 2

    search_data = client.get("/api/logs?search=step+D").json()
    assert len(search_data["logs"]) == 1
    assert search_data["logs"][0]["message"] == "Warn step D"

    del_res = client.delete("/api/logs")
    assert del_res.status_code == 200

    empty_data = client.get("/api/logs").json()
    assert len(empty_data["logs"]) == 0

    set_log_database(None)
    handle.engine.dispose()
