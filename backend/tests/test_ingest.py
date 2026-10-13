"""Audio ingest pipeline and streaming tests (port of ingest.test.ts)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import meeting_paths
from olive.services.ingest import IngestService

SAMPLE_AUDIO = b"arbitrary sample audio bytes for testing"


def test_ingests_audio_file_deduplicates_and_streams_range(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000

    ingest_service = IngestService(
        db=handle.engine,
        meetings_dir=meetings_dir,
        now=lambda: now,
    )
    app = create_app(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "ingestService": ingest_service,
        }
    )
    client = TestClient(app)

    # 1. Initial upload
    upload_res = client.post(
        "/api/ingest",
        files={"file": ("interview.m4a", SAMPLE_AUDIO, "audio/mp4")},
        data={"title": "Job Candidate Interview"},
    )
    assert upload_res.status_code == 201
    upload_data = upload_res.json()
    assert upload_data["deduped"] is False
    assert upload_data["meeting"]["title"] == "Job Candidate Interview"
    assert upload_data["meeting"]["source"] == "upload"
    meeting_id = upload_data["meetingId"]

    with handle.engine.connect() as conn:
        meetings = conn.execute(text("SELECT * FROM meetings")).mappings().all()
        recordings = conn.execute(text("SELECT * FROM recordings")).mappings().all()
    assert len(meetings) == 1
    assert len(recordings) == 1
    assert recordings[0]["mime"] == "audio/mp4"

    paths = meeting_paths(meetings_dir, now, "Job Candidate Interview", meeting_id)
    audio_disk_path = Path(paths.folder) / upload_data["audioPath"]
    assert audio_disk_path.exists()
    assert audio_disk_path.read_bytes() == SAMPLE_AUDIO

    # 2. Deduplication on identical upload
    second_res = client.post(
        "/api/ingest",
        files={"file": ("duplicate.m4a", SAMPLE_AUDIO, "audio/mp4")},
    )
    assert second_res.status_code == 200
    second_data = second_res.json()
    assert second_data["deduped"] is True
    assert second_data["meetingId"] == meeting_id

    # 3. Audio streaming endpoint GET /api/meetings/:id/audio
    stream_res = client.get(f"/api/meetings/{meeting_id}/audio")
    assert stream_res.status_code == 200
    assert stream_res.headers["content-type"] == "audio/mp4"
    assert stream_res.headers["accept-ranges"] == "bytes"
    assert stream_res.content == SAMPLE_AUDIO

    # 4. Range request support
    range_res = client.get(
        f"/api/meetings/{meeting_id}/audio",
        headers={"range": "bytes=0-9"},
    )
    assert range_res.status_code == 206
    assert "bytes 0-9/" in range_res.headers["content-range"]
    assert range_res.content == SAMPLE_AUDIO[:10]

    handle.engine.dispose()


def test_enforces_ingest_token_and_identifies_ios_shortcut(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000

    ingest_service = IngestService(
        db=handle.engine,
        meetings_dir=meetings_dir,
        now=lambda: now,
    )
    app = create_app(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "ingestService": ingest_service,
            "ingestToken": "secret-token-xyz",
        }
    )
    client = TestClient(app)

    # Missing token
    unauth_res = client.post(
        "/api/ingest",
        files={"file": ("memo.m4a", SAMPLE_AUDIO, "audio/x-m4a")},
    )
    assert unauth_res.status_code == 401

    # Authorized upload with iOS Shortcut User-Agent
    auth_res = client.post(
        "/api/ingest",
        headers={
            "Authorization": "Bearer secret-token-xyz",
            "User-Agent": "Shortcuts/1145.1.1 (iPhone; iOS 17.5)",
        },
        files={"file": ("memo.m4a", SAMPLE_AUDIO, "audio/x-m4a")},
    )
    assert auth_res.status_code == 201
    data = auth_res.json()
    assert data["meeting"]["source"] == "ios-shortcut"

    handle.engine.dispose()
