"""Audio readiness (audioStatus) + Plaud audio retry endpoint tests."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import ensure_meeting_folder, meeting_paths
from olive.plaud.poller import PlaudPoller


def _insert_meeting(
    conn: Any,
    *,
    mid: str,
    title: str,
    source: str,
    status: str,
    now: int,
    start: int | None = None,
) -> None:
    st = start if start is not None else now - 60_000
    conn.execute(
        text(
            """
            INSERT INTO meetings (
              id, title, start_time, end_time, source, status, tags,
              primary_transcript_artifact_id, primary_summary_artifact_id,
              last_error, created_at, updated_at
            ) VALUES (
              :id, :title, :start, :end, :source, :status, '[]',
              NULL, NULL, NULL, :now, :now
            )
            """
        ),
        {
            "id": mid,
            "title": title,
            "start": st,
            "end": st + 60_000,
            "source": source,
            "status": status,
            "now": now,
        },
    )


def _insert_recording(
    conn: Any, *, rid: str, mid: str, rel_path: str, now: int, provider: str = "plaud"
) -> None:
    conn.execute(
        text(
            """
            INSERT INTO recordings (
              id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
              provider, provider_recording_id, created_at
            ) VALUES (
              :id, :mid, :path, 'audio/mp4', 60000, 10, :sha,
              :prov, :fid, :now
            )
            """
        ),
        {
            "id": rid,
            "mid": mid,
            "path": rel_path,
            "sha": f"sha-{rid}",
            "prov": provider,
            "fid": f"file-{mid}",
            "now": now,
        },
    )


def _make_app(handle: Any, meetings_dir: str) -> tuple[TestClient, PlaudPoller]:
    poller = PlaudPoller({"db": handle.engine, "meetingsDir": meetings_dir, "now": lambda: 1_000})
    app = create_app({"db": handle.engine, "meetingsDir": meetings_dir, "plaudPoller": poller})
    return TestClient(app), poller


def test_plaud_pending_meeting_reports_retrieving(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = int(time.time() * 1000)
    with handle.engine.begin() as conn:
        _insert_meeting(
            conn, mid="plaud-pending", title="Plaud pending", source="plaud", status="processing", now=now
        )
        conn.execute(
            text(
                "INSERT INTO plaud_ingest_state (meeting_id, plaud_file_id, first_seen_at, pcs_deadline_at, pcs_resolved)"
                " VALUES ('plaud-pending', 'file-1', :now, :dl, 0)"
            ),
            {"now": now, "dl": now + 300_000},
        )
    client, _ = _make_app(handle, meetings_dir)

    lst = client.get("/api/meetings").json()["meetings"]
    assert len(lst) == 1
    assert lst[0]["audioStatus"] == "retrieving"
    assert lst[0]["canRetryAudio"] is True

    detail = client.get("/api/meetings/plaud-pending").json()
    assert detail["meeting"]["audioStatus"] == "retrieving"
    assert detail["meeting"]["canRetryAudio"] is True
    assert detail["recordings"] == []
    handle.engine.dispose()


def test_ready_meeting_with_file_on_disk(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = int(time.time() * 1000)
    with handle.engine.begin() as conn:
        _insert_meeting(conn, mid="up-ready", title="Upload ready", source="upload", status="ready", now=now)
    # Create folder + audio file, then the recording row pointing at it.
    paths = ensure_meeting_folder(meeting_paths(meetings_dir, now - 60_000, "Upload ready", "up-ready"))
    rel = "audio/rec-1.m4a"
    (Path(paths.folder) / rel).parent.mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / rel).write_bytes(b"fake-audio")
    with handle.engine.begin() as conn:
        _insert_recording(conn, rid="rec-1", mid="up-ready", rel_path=rel, now=now, provider="upload")
    client, _ = _make_app(handle, meetings_dir)

    lst = client.get("/api/meetings").json()["meetings"]
    assert lst[0]["audioStatus"] == "ready"
    assert lst[0]["canRetryAudio"] is False
    handle.engine.dispose()


def test_missing_file_reports_missing_and_retryable_for_plaud(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = int(time.time() * 1000)
    with handle.engine.begin() as conn:
        _insert_meeting(
            conn, mid="plaud-missing", title="Plaud missing", source="plaud", status="ready", now=now
        )
        _insert_recording(conn, rid="rec-9", mid="plaud-missing", rel_path="audio/rec-9.m4a", now=now)
        conn.execute(
            text(
                "INSERT INTO plaud_ingest_state (meeting_id, plaud_file_id, first_seen_at, pcs_deadline_at, pcs_resolved)"
                " VALUES ('plaud-missing', 'file-9', :now, :dl, 1)"
            ),
            {"now": now - 600_000, "dl": now - 300_000},
        )
    client, _ = _make_app(handle, meetings_dir)

    detail = client.get("/api/meetings/plaud-missing").json()
    assert detail["meeting"]["audioStatus"] == "missing"
    assert detail["meeting"]["canRetryAudio"] is True
    handle.engine.dispose()


def test_retry_endpoint_resets_ingest_state(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = int(time.time() * 1000)
    with handle.engine.begin() as conn:
        _insert_meeting(conn, mid="plaud-retry", title="Plaud retry", source="plaud", status="ready", now=now)
        conn.execute(
            text(
                "INSERT INTO plaud_ingest_state (meeting_id, plaud_file_id, first_seen_at, pcs_deadline_at, pcs_resolved)"
                " VALUES ('plaud-retry', 'file-r', :now, :dl, 1)"
            ),
            {"now": now - 600_000, "dl": now - 300_000},
        )
    client, _ = _make_app(handle, meetings_dir)

    res = client.post("/api/meetings/plaud-retry/audio/retry")
    assert res.status_code == 202
    assert res.json()["meetingId"] == "plaud-retry"

    with handle.engine.connect() as conn:
        state = (
            conn.execute(text("SELECT * FROM plaud_ingest_state WHERE meeting_id = 'plaud-retry'"))
            .mappings()
            .one()
        )
        meeting = conn.execute(text("SELECT * FROM meetings WHERE id = 'plaud-retry'")).mappings().one()
    assert state["pcs_resolved"] == 0
    assert meeting["status"] == "processing"
    handle.engine.dispose()


def test_retry_endpoint_rejects_non_plaud_and_unknown(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = int(time.time() * 1000)
    with handle.engine.begin() as conn:
        _insert_meeting(conn, mid="up-no-retry", title="Upload", source="upload", status="ready", now=now)
    client, _ = _make_app(handle, meetings_dir)

    assert client.post("/api/meetings/up-no-retry/audio/retry").status_code == 400
    assert client.post("/api/meetings/does-not-exist/audio/retry").status_code == 404

    with handle.engine.begin() as conn:
        _insert_meeting(
            conn, mid="plaud-no-state", title="Plaud no state", source="plaud", status="ready", now=now
        )
    assert client.post("/api/meetings/plaud-no-state/audio/retry").status_code == 404
    handle.engine.dispose()
