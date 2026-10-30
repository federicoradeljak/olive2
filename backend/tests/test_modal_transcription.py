"""Modal GPU provider flow through TranscriptionService (fake worker, no network)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

import olive.providers.modal.transcriber as modal_transcriber
import olive.services.transcription as transcription_module
from olive.db import create_db
from olive.layout import meeting_paths
from olive.ml import AbortController
from olive.providers.modal import ModalClient
from olive.services.transcription import (
    STAGE_MODAL_TRANSCRIBE,
    TranscriptionService,
    is_known_transcription_provider,
    normalize_transcription_provider,
)

WORKER_RESULT: dict[str, Any] = {
    "transcript": {
        "segments": [
            {"startMs": 0, "endMs": 1000, "speaker": "Speaker 1", "text": "Hola a todos."},
            {"startMs": 1200, "endMs": 2500, "speaker": "Speaker 2", "text": "Buen día."},
        ],
        "language": "es",
        "durationMs": 9000,
    },
    "gpu": "L4",
    "timings": {"loadSec": 4.0, "runSec": 16.0, "diarizeSec": 6.0, "asrSec": 9.0},
}


class _FakeHandle:
    def __init__(self, result: dict[str, Any] | None, polls_before_done: int = 0) -> None:
        self.object_id = "fc-123"
        self.result = result
        self.polls_left = polls_before_done
        self.cancelled = False

    async def poll(self, timeout: float) -> tuple[bool, Any]:
        await asyncio.sleep(0)
        if self.polls_left > 0:
            self.polls_left -= 1
            return False, None
        return True, self.result

    async def cancel(self) -> None:
        self.cancelled = True


def _seed_meeting(tmp_path: Path) -> tuple[Any, str, Any]:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-modal-1"
    paths = meeting_paths(meetings_dir, now, "Modal Meeting", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/test.m4a").write_bytes(b"fake audio bytes")
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id, last_error, created_at, updated_at)
                VALUES (:id, 'Modal Meeting', :now, :end, 'upload', 'ready', '[]', NULL, NULL, NULL, :now, :now)
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 9000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at)
                VALUES ('rec-modal', :mid, 'audio/test.m4a', 'audio/mp4', 9000, 16, 'sha-modal', 'upload', NULL, :now)
                """
            ),
            {"mid": meeting_id, "now": now},
        )
    return handle, meeting_id, paths


def _service(
    handle: Any,
    meetings_dir: str,
    calls: list[dict[str, Any]],
    fake: _FakeHandle,
    **extra: Any,
) -> TranscriptionService:
    async def _spawn(audio_bytes: bytes, options: dict[str, Any]) -> _FakeHandle:
        calls.append({"audio": audio_bytes, "options": options})
        return fake

    client = ModalClient({"spawn": _spawn, "pollIntervalSec": 0.01})
    return TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "modalClient": client,
            "now": lambda: 1_700_000_001_000,
            **extra,
        }
    )


def _stage_status(handle: Any, meeting_id: str) -> dict[str, Any]:
    with handle.engine.connect() as conn:
        return dict(
            conn.execute(
                text("SELECT * FROM stage_runs WHERE meeting_id = :mid AND stage = :st"),
                {"mid": meeting_id, "st": STAGE_MODAL_TRANSCRIBE},
            )
            .mappings()
            .one()
        )


@pytest.fixture(autouse=True)
def _fake_flac(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(modal_transcriber, "prepare_modal_flac", lambda _path: b"flac-bytes")


def test_provider_routing_helpers() -> None:
    assert normalize_transcription_provider("modal") == "modal"
    assert normalize_transcription_provider("MODAL") == "modal"
    assert is_known_transcription_provider("modal") is True
    assert transcription_module.TRANSCRIBE_QUEUE_BY_PROVIDER["modal"] == "modal"


async def test_modal_flow_persists_transcript_and_gpu_usage(tmp_path: Path) -> None:
    handle, meeting_id, paths = _seed_meeting(tmp_path)
    calls: list[dict[str, Any]] = []
    service = _service(
        handle,
        str(tmp_path / "meetings"),
        calls,
        _FakeHandle(WORKER_RESULT, polls_before_done=2),
        modalAsrModel=lambda: "whisper-large-v3-turbo",
    )

    progress: list[str] = []
    result = await service.transcribe_meeting(
        meeting_id,
        {"provider": "modal", "language": "es", "onProgress": lambda u: progress.append(u.stage)},
    )

    assert result["status"] == "done"
    assert result["jobId"] == "fc-123"
    assert calls[0]["audio"] == b"flac-bytes"
    assert calls[0]["options"]["asrModel"] == "whisper-large-v3-turbo"
    assert calls[0]["options"]["language"] == "es"
    assert progress[0] == "uploading"
    assert progress[-1] == "done"

    stage_run = _stage_status(handle, meeting_id)
    assert stage_run["status"] == "done"
    assert stage_run["provider_job_id"] == "fc-123"

    with handle.engine.connect() as conn:
        artifacts = (
            conn.execute(
                text("SELECT provider, format FROM artifacts WHERE meeting_id = :mid ORDER BY format"),
                {"mid": meeting_id},
            )
            .mappings()
            .all()
        )
        usage = (
            conn.execute(text("SELECT * FROM usage_events WHERE meeting_id = :mid"), {"mid": meeting_id})
            .mappings()
            .all()
        )
    assert [(a["provider"], a["format"]) for a in artifacts] == [("modal", "json"), ("modal", "txt")]
    # One usage row, from measured GPU seconds (not the artifact-based estimate).
    assert len(usage) == 1
    row = usage[0]
    assert row["provider"] == "modal"
    assert row["model"] == "whisper-large-v3-turbo"
    assert row["source"] == "modal:fc-123"
    assert row["audio_seconds"] == pytest.approx(9.0)
    assert row["cost_usd"] == pytest.approx(20.0 * 0.000222)
    detail = json.loads(row["detail"])
    assert detail["gpu"] == "L4"
    assert detail["gpuSeconds"] == pytest.approx(20.0)

    saved = json.loads((Path(paths.folder) / "transcripts/modal.json").read_text())
    assert [s["speaker"] for s in saved["segments"]] == ["Speaker 1", "Speaker 2"]
    handle.engine.dispose()


async def test_modal_request_asr_model_overrides_setting(tmp_path: Path) -> None:
    handle, meeting_id, _paths = _seed_meeting(tmp_path)
    calls: list[dict[str, Any]] = []
    service = _service(
        handle,
        str(tmp_path / "meetings"),
        calls,
        _FakeHandle(WORKER_RESULT),
        modalAsrModel="whisper-large-v3-turbo",
    )
    result = await service.transcribe_meeting(
        meeting_id, {"provider": "modal", "asrModel": "whisper-large-v3"}
    )
    assert result["status"] == "done"
    assert calls[0]["options"]["asrModel"] == "whisper-large-v3"
    handle.engine.dispose()


async def test_modal_auto_language_falls_back_to_english_only_for_cohere(tmp_path: Path) -> None:
    handle, meeting_id, _paths = _seed_meeting(tmp_path)
    calls: list[dict[str, Any]] = []
    service = _service(handle, str(tmp_path / "meetings"), calls, _FakeHandle(WORKER_RESULT))
    for asr_model in ("cohere", "whisper-large-v3"):
        await service.transcribe_meeting(
            meeting_id, {"provider": "modal", "asrModel": asr_model, "language": "auto", "force": True}
        )
    assert [c["options"]["language"] for c in calls] == ["en", "auto"]
    handle.engine.dispose()


async def test_modal_unknown_asr_model_fails_without_spawning(tmp_path: Path) -> None:
    handle, meeting_id, _paths = _seed_meeting(tmp_path)
    calls: list[dict[str, Any]] = []
    service = _service(handle, str(tmp_path / "meetings"), calls, _FakeHandle(WORKER_RESULT))
    result = await service.transcribe_meeting(meeting_id, {"provider": "modal", "asrModel": "bogus"})
    assert result["status"] == "error"
    assert "Unknown ASR model" in str(result["error"])
    assert calls == []
    assert _stage_status(handle, meeting_id)["status"] == "error"
    handle.engine.dispose()


async def test_modal_worker_failure_marks_error(tmp_path: Path) -> None:
    handle, meeting_id, _paths = _seed_meeting(tmp_path)

    async def _boom(_audio: bytes, _options: dict[str, Any]) -> Any:
        raise RuntimeError("App 'olive-gpu' not found")

    service = _service(
        handle,
        str(tmp_path / "meetings"),
        [],
        _FakeHandle(WORKER_RESULT),
        modalClient=ModalClient({"spawn": _boom}),
    )
    result = await service.transcribe_meeting(meeting_id, {"provider": "modal"})
    assert result["status"] == "error"
    assert "olive-gpu" in str(result["error"])
    assert _stage_status(handle, meeting_id)["status"] == "error"
    handle.engine.dispose()


async def test_modal_abort_cancels_remote_call(tmp_path: Path) -> None:
    handle, meeting_id, _paths = _seed_meeting(tmp_path)
    fake = _FakeHandle(WORKER_RESULT, polls_before_done=10_000)
    service = _service(handle, str(tmp_path / "meetings"), [], fake)
    controller = AbortController()

    async def _abort_soon() -> None:
        # Abort only once the remote call is being polled: FLAC conversion runs
        # before spawn and can outlast any fixed delay on a slow CI runner.
        while fake.polls_left == 10_000:
            await asyncio.sleep(0.001)
        controller.abort()

    aborter = asyncio.ensure_future(_abort_soon())
    result = await service.transcribe_meeting(meeting_id, {"provider": "modal", "signal": controller.signal})
    await aborter
    assert result["status"] == "cancelled"
    assert fake.cancelled is True
    assert _stage_status(handle, meeting_id)["status"] == "cancelled"
    handle.engine.dispose()


async def test_modal_sends_custom_vocabulary_only_to_whisper(tmp_path: Path) -> None:
    handle, meeting_id, _paths = _seed_meeting(tmp_path)
    calls: list[dict[str, Any]] = []
    service = _service(
        handle,
        str(tmp_path / "meetings"),
        calls,
        _FakeHandle(WORKER_RESULT),
        customVocabulary=["Olive", "Plaud"],
    )
    for asr_model in ("cohere", "whisper-large-v3"):
        await service.transcribe_meeting(
            meeting_id, {"provider": "modal", "asrModel": asr_model, "force": True}
        )
    assert [c["options"]["additionalVocab"] for c in calls] == [None, ["Olive", "Plaud"]]
    handle.engine.dispose()
