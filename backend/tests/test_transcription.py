"""Transcription service and webhook API tests (port of transcription.test.ts)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import meeting_paths
from olive.ml import AbortController
from olive.providers.speechmatics import SpeechmaticsClient
from olive.services.transcription import (
    STAGE_SPEECHMATICS_TRANSCRIBE,
    TranscriptionService,
    _ActiveTranscriptionJob,
)

AUDIO_BYTES = b"fake audio bytes"

SAMPLE_JSON_V2: dict[str, Any] = {
    "format": "2.0",
    "job": {"id": "sm-job-456", "duration": 5.0, "lang": "en"},
    "results": [
        {
            "type": "word",
            "start_time": 0.1,
            "end_time": 0.5,
            "alternatives": [{"content": "Welcome", "confidence": 0.99, "speaker": "Alice"}],
        },
        {
            "type": "word",
            "start_time": 0.6,
            "end_time": 1.0,
            "alternatives": [{"content": "everyone", "confidence": 0.98, "speaker": "Alice"}],
        },
        {
            "type": "punctuation",
            "start_time": 1.0,
            "end_time": 1.0,
            "alternatives": [{"content": ".", "confidence": 1.0, "speaker": "Alice"}],
        },
    ],
    "speakers": [{"speaker": "Alice", "speaker_identifiers": ["voice-alice-id-1"]}],
}


def _create_mock_speechmatics_client(json_v2: dict[str, Any] = SAMPLE_JSON_V2):
    delete_calls: list[str] = []

    class _MockBatch:
        async def createTranscriptionJob(self, *_args: Any) -> dict[str, str]:
            return {"id": "sm-job-456"}

        async def getJob(self, jid: str) -> dict[str, Any]:
            return {
                "job": {
                    "id": jid,
                    "status": "done",
                    "created_at": "2026-08-16T12:00:00Z",
                    "data_name": "test.m4a",
                    "duration": 5.0,
                }
            }

        async def getJobResult(self, _jid: str, fmt: str = "json-v2") -> Any:
            if fmt == "json-v2":
                return json_v2
            return "Alice: Welcome everyone."

        async def deleteJob(self, jid: str) -> dict[str, Any]:
            delete_calls.append(jid)
            return {"job": {"id": jid, "status": "deleted", "created_at": "", "data_name": ""}}

    client = SpeechmaticsClient({"apiKey": "test-key", "batchClient": _MockBatch()})
    return client, delete_calls


async def test_transcribes_meeting_recording_and_persists_artifacts_speakers_and_stage_run(
    tmp_path: Path,
) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-test-1"

    paths = meeting_paths(meetings_dir, now, "Test Meeting", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/test.m4a").write_bytes(AUDIO_BYTES)

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Test Meeting', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 5000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  'rec-1', :mid, 'audio/test.m4a', 'audio/mp4', 5000, :sz,
                  'fake-sha256-test', 'upload', NULL, :now
                )
                """
            ),
            {"mid": meeting_id, "sz": len(AUDIO_BYTES), "now": now},
        )

    sm_client, delete_calls = _create_mock_speechmatics_client()
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "speechmaticsClient": sm_client,
            "now": lambda: now + 1000,
        }
    )

    result = await service.transcribe_meeting(
        meeting_id, {"poll": True, "pollIntervalMs": 10}
    )
    assert result["status"] == "done"
    assert result["jobId"] == "sm-job-456"
    assert result["transcriptArtifactId"]

    with handle.engine.connect() as conn:
        stage_run = conn.execute(
            text("SELECT * FROM stage_runs WHERE meeting_id = :mid AND stage = :st"),
            {"mid": meeting_id, "st": STAGE_SPEECHMATICS_TRANSCRIBE},
        ).mappings().one()
        assert stage_run["status"] == "done"
        assert stage_run["provider_job_id"] == "sm-job-456"

        artifacts = conn.execute(
            text("SELECT * FROM artifacts WHERE meeting_id = :mid"),
            {"mid": meeting_id},
        ).mappings().all()
        assert len(artifacts) == 2
        assert [(a["provider"], a["format"]) for a in artifacts] == [
            ("speechmatics", "json"),
            ("speechmatics", "txt"),
        ]

        meeting = conn.execute(
            text("SELECT * FROM meetings WHERE id = :id"),
            {"id": meeting_id},
        ).mappings().one()
        assert meeting["primary_transcript_artifact_id"] == result["transcriptArtifactId"]

        speakers = conn.execute(text("SELECT * FROM speakers")).mappings().all()
        assert len(speakers) == 1
        assert speakers[0]["name"] == "Alice"

    assert (Path(paths.folder) / "transcripts/speechmatics.json").exists()
    txt_file = Path(paths.folder) / "transcripts/speechmatics.txt"
    assert txt_file.exists()
    assert "Alice: Welcome everyone." in txt_file.read_text(encoding="utf-8")
    assert len(delete_calls) == 1
    handle.engine.dispose()


def test_api_endpoints_triggers_transcription_handles_webhook_and_retrieves_detail(
    tmp_path: Path,
) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-api-2"

    paths = meeting_paths(meetings_dir, now, "API Meeting", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/api.m4a").write_bytes(AUDIO_BYTES)

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'API Meeting', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 5000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  'rec-api-2', :mid, 'audio/api.m4a', 'audio/mp4', 5000, :sz,
                  'sha-api-2', 'upload', NULL, :now
                )
                """
            ),
            {"mid": meeting_id, "sz": len(AUDIO_BYTES), "now": now},
        )

    sm_client, _ = _create_mock_speechmatics_client()
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "speechmaticsClient": sm_client,
            "webhookSecret": "secret-test-123",
        }
    )
    app = create_app(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "transcriptionService": service,
            "speechmaticsWebhookSecret": "secret-test-123",
        }
    )
    client = TestClient(app)

    trigger_res = client.post(
        f"/api/meetings/{meeting_id}/transcribe",
        json={"poll": False, "provider": "speechmatics"},
    )
    assert trigger_res.status_code == 200
    trigger_data = trigger_res.json()
    assert trigger_data["status"] == "running"
    assert trigger_data["jobId"] == "sm-job-456"
    stage_run_id = trigger_data["stageRunId"]

    webhook_res = client.post(
        f"/api/webhooks/speechmatics?meetingId={meeting_id}&stageRunId={stage_run_id}",
        headers={"Authorization": "Bearer secret-test-123"},
        json=SAMPLE_JSON_V2,
    )
    assert webhook_res.status_code == 200
    assert webhook_res.json()["status"] == "done"

    detail_res = client.get(f"/api/meetings/{meeting_id}")
    assert detail_res.status_code == 200
    detail = detail_res.json()
    assert detail["meeting"]["id"] == meeting_id
    assert len(detail["artifacts"]) == 2
    assert len(detail["speakers"]) == 1
    assert detail["speakers"][0]["name"] == "Alice"
    assert "Welcome" in (detail["transcriptContent"] or "")
    handle.engine.dispose()


async def test_late_in_progress_updates_do_not_overwrite_cancelled(tmp_path: Path) -> None:
    """Cancelling must stick: stale in-progress updates arriving after the
    cancel (the in-flight job draining its queue a few hundred ms later)
    must not flip the meeting back to in-progress."""
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    meeting_id = "m-cancel-race"

    sm_client, _ = _create_mock_speechmatics_client()
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "speechmaticsClient": sm_client,
        }
    )

    controller = AbortController()
    service._active_jobs[meeting_id] = _ActiveTranscriptionJob(
        abort_controller=controller,
        provider="local",
    )
    service.emit_progress(
        meeting_id,
        {"stage": "transcribing", "percent": 40, "message": "working..."},
    )
    assert service.get_transcription_progress(meeting_id) is not None
    assert service.get_transcription_progress(meeting_id).stage == "transcribing"  # type: ignore[union-attr]

    cancel_res = await service.cancel_transcription(meeting_id)
    assert cancel_res["success"] is True
    assert service.get_transcription_progress(meeting_id) is not None
    assert service.get_transcription_progress(meeting_id).stage == "cancelled"  # type: ignore[union-attr]

    # Stale update from the in-flight job arriving after the cancel.
    service.emit_progress(
        meeting_id,
        {"stage": "transcribing", "percent": 60, "message": "stale late update"},
    )
    progress = service.get_transcription_progress(meeting_id)
    assert progress is not None
    assert progress.stage == "cancelled"  # type: ignore[union-attr]
    handle.engine.dispose()
