"""Muse provider flow through TranscriptionService (chunked, no network)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

import olive.providers.muse.transcriber as muse_transcriber
from olive.db import create_db
from olive.layout import meeting_paths
from olive.providers.muse import MuseClient
from olive.services.transcription import (
    STAGE_MUSE_TRANSCRIBE,
    TranscriptionService,
    is_known_transcription_provider,
    normalize_transcription_provider,
)

CHUNK_RESPONSES: list[dict[str, Any]] = [
    {
        "transcript": "Hello everyone.",
        "audioDurationMs": 5000,
        "turns": [{"text": "Hello everyone.", "speaker": "A", "startMs": 100, "endMs": 1000}],
        "sessionId": "s-0",
    },
    {
        # Same raw label as chunk 0 but a different request scope: must
        # become Speaker 2, never merge with chunk 0's Speaker 1.
        "transcript": "Hi there.",
        "audioDurationMs": 4000,
        "turns": [{"text": "Hi there.", "speaker": "A", "startMs": 200, "endMs": 1200}],
        "sessionId": "s-1",
    },
]


def _sender_factory(calls: list[dict[str, Any]]):
    async def _send(
        url: str,
        headers: dict[str, str],
        request_json: dict[str, Any],
        audio_bytes: bytes,
        filename: str,
        session_id: str,
        timeout_s: float,
    ) -> dict[str, Any]:
        calls.append({"request": request_json, "session_id": session_id})
        return CHUNK_RESPONSES[len(calls) - 1]

    return _send


def _seed_meeting(tmp_path: Path) -> tuple[Any, str, Any]:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-muse-1"
    paths = meeting_paths(meetings_dir, now, "Muse Meeting", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/test.m4a").write_bytes(b"fake audio bytes")
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id, last_error, created_at, updated_at)
                VALUES (:id, 'Muse Meeting', :now, :end, 'upload', 'ready', '[]', NULL, NULL, NULL, :now, :now)
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 9000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at)
                VALUES ('rec-muse', :mid, 'audio/test.m4a', 'audio/mp4', 9000, 16, 'sha-muse', 'upload', NULL, :now)
                """
            ),
            {"mid": meeting_id, "now": now},
        )
    return handle, meeting_id, paths


def _service(
    handle: Any, meetings_dir: str, calls: list[dict[str, Any]], **extra: Any
) -> TranscriptionService:
    client = MuseClient({"apiKey": "test-key", "sender": _sender_factory(calls)})
    return TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "museClient": client,
            "now": lambda: 1_700_000_001_000,
            **extra,
        }
    )


def test_provider_routing_helpers() -> None:
    assert normalize_transcription_provider("muse") == "muse"
    assert normalize_transcription_provider("MUSE") == "muse"
    assert is_known_transcription_provider("muse") is True
    assert is_known_transcription_provider("bogus") is False


async def test_muse_chunked_flow_merges_offsets_and_artifacts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    handle, meeting_id, paths = _seed_meeting(tmp_path)
    calls: list[dict[str, Any]] = []
    service = _service(handle, str(tmp_path / "meetings"), calls)

    monkeypatch.setattr(
        muse_transcriber,
        "prepare_muse_wav_chunks",
        lambda _path: [(b"wav-0", 0), (b"wav-1", 5000)],
    )

    progress_updates: list[tuple[str, float, str]] = []
    result = await service.transcribe_meeting(
        meeting_id,
        {
            "provider": "muse",
            "language": "en",
            "additionalVocab": ["Olive"],
            "onProgress": lambda u: progress_updates.append((u.stage, u.percent, u.message)),
        },
    )

    assert result["status"] == "done"
    assert len(calls) == 2
    assert calls[0]["request"]["mode"] == "DIARIZATION"
    assert calls[0]["request"]["keywords"] == ["Olive"]
    assert calls[0]["request"]["languageBias"] == ["English"]
    assert calls[0]["session_id"].startswith(result["jobId"])
    stages = [s for s, _p, _m in progress_updates]
    assert stages[0] == "uploading"
    assert "transcribing" in stages
    assert stages[-1] == "done"

    with handle.engine.connect() as conn:
        stage_run = (
            conn.execute(
                text("SELECT * FROM stage_runs WHERE meeting_id = :mid AND stage = :st"),
                {"mid": meeting_id, "st": STAGE_MUSE_TRANSCRIBE},
            )
            .mappings()
            .one()
        )
        assert stage_run["status"] == "done"
        artifacts = (
            conn.execute(
                text("SELECT provider, format FROM artifacts WHERE meeting_id = :mid ORDER BY format"),
                {"mid": meeting_id},
            )
            .mappings()
            .all()
        )
        assert [(a["provider"], a["format"]) for a in artifacts] == [
            ("muse", "json"),
            ("muse", "txt"),
        ]

    saved = json.loads((Path(paths.folder) / "transcripts/muse.json").read_text())
    assert [(s["speaker"], s["startMs"], s["endMs"]) for s in saved["segments"]] == [
        ("Speaker 1", 100, 1000),
        ("Speaker 2", 5200, 6200),
    ]
    assert "Speaker 2: Hi there." in (Path(paths.folder) / "transcripts/muse.txt").read_text()
    handle.engine.dispose()


async def test_muse_chunk_failure_marks_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    handle, meeting_id, _paths = _seed_meeting(tmp_path)
    calls: list[dict[str, Any]] = []

    async def _boom(_url: str, _h: dict, _r: dict, _a: bytes, _f: str, _s: str, _t: float) -> dict[str, Any]:
        raise RuntimeError("Muse transcription failed (HTTP 500): boom")

    service = _service(
        handle,
        str(tmp_path / "meetings"),
        calls,
        museClient=MuseClient({"apiKey": "test-key", "sender": _boom}),
    )
    monkeypatch.setattr(muse_transcriber, "prepare_muse_wav_chunks", lambda _path: [(b"wav-0", 0)])

    result = await service.transcribe_meeting(meeting_id, {"provider": "muse"})
    assert result["status"] == "error"
    assert "boom" in str(result["error"])
    with handle.engine.connect() as conn:
        status = (
            conn.execute(
                text("SELECT status FROM stage_runs WHERE meeting_id = :mid AND stage = :st"),
                {"mid": meeting_id, "st": STAGE_MUSE_TRANSCRIBE},
            )
            .mappings()
            .one()["status"]
        )
        assert status == "error"
    handle.engine.dispose()
