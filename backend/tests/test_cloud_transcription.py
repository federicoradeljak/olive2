"""The cloud run lifecycle, driven through TranscriptionService with a fake transcriber."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from olive.db import create_db
from olive.layout import meeting_paths
from olive.ml.worker import AbortController
from olive.schemas import Transcript, TranscriptSegment
from olive.services.cloud_transcription import (
    CLOUD_PROVIDERS,
    CloudJob,
    CloudTranscript,
    Submitted,
    TranscriptionCancelled,
)
from olive.services.transcription import TranscriptionService

NOW = 1_700_000_000_000
MEETING_ID = "m-cloud-1"
STAGE = CLOUD_PROVIDERS["assemblyai"].stage


def _transcript() -> Transcript:
    return Transcript(
        segments=[TranscriptSegment(speaker="Speaker 1", startMs=0, endMs=1000, text="Hello there.")],
        durationMs=1000,
    )


class _FakeTranscriber:
    spec = CLOUD_PROVIDERS["assemblyai"]

    def __init__(self, outcome: Any = None) -> None:
        self.outcome: Any = outcome if outcome is not None else CloudTranscript(_transcript())
        self.calls = 0
        self.released: list[str] = []

    async def transcribe(self, job: CloudJob) -> CloudTranscript | Submitted:
        self.calls += 1
        job.set_job_id("fake-job-1")
        await job.progress("transcribing", 40, "Working...")
        outcome: Any = self.outcome
        if isinstance(outcome, BaseException):
            raise outcome
        if isinstance(outcome, CloudTranscript | Submitted):
            return outcome
        return outcome(job)

    async def release(self, job_id: str) -> None:
        self.released.append(job_id)


def _seed(tmp_path: Path) -> tuple[Any, str]:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    paths = meeting_paths(meetings_dir, NOW, "Cloud Meeting", MEETING_ID)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/test.m4a").write_bytes(b"fake audio bytes")
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id, last_error, created_at, updated_at)
                VALUES (:id, 'Cloud Meeting', :now, :end, 'upload', 'ready', '[]', NULL, NULL, NULL, :now, :now)
                """
            ),
            {"id": MEETING_ID, "now": NOW, "end": NOW + 5000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at)
                VALUES ('rec-cloud', :mid, 'audio/test.m4a', 'audio/mp4', 5000, 16, 'sha-cloud', 'upload', NULL, :now)
                """
            ),
            {"mid": MEETING_ID, "now": NOW},
        )
    return handle, meetings_dir


def _service(handle: Any, meetings_dir: str, transcriber: _FakeTranscriber) -> TranscriptionService:
    return TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "now": lambda: NOW + 1000,
            "cloudTranscribers": {"assemblyai": transcriber},
            # Keep cloud labels; no local voiceprint matching in these tests.
            "cloudSpeakerIdentifier": lambda *_args: None,
        }
    )


def _stage_run(handle: Any) -> dict[str, Any]:
    with handle.engine.connect() as conn:
        row = conn.execute(text("SELECT * FROM stage_runs WHERE stage = :s"), {"s": STAGE}).mappings().first()
    assert row is not None
    return dict(row)


def _meeting_error(handle: Any) -> str | None:
    with handle.engine.connect() as conn:
        return conn.execute(
            text("SELECT last_error FROM meetings WHERE id = :id"), {"id": MEETING_ID}
        ).scalar()


def _usage_sources(handle: Any) -> list[str]:
    with handle.engine.connect() as conn:
        return [
            str(r[0])
            for r in conn.execute(text("SELECT source FROM usage_events WHERE kind = 'transcription'"))
        ]


async def _transcribe(svc: TranscriptionService, **opts: Any) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    updates: list[tuple[str, str]] = []
    res = await svc.transcribe_meeting(
        MEETING_ID,
        {"provider": "assemblyai", "onProgress": lambda u: updates.append((u.stage, u.message)), **opts},
    )
    return res, updates


async def test_success_persists_transcript_and_job_id(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    fake = _FakeTranscriber()
    res, updates = await _transcribe(_service(handle, meetings_dir, fake))

    assert res["status"] == "done"
    assert res["jobId"] == "fake-job-1"
    run = _stage_run(handle)
    assert (run["status"], run["provider_job_id"], run["attempts"]) == ("done", "fake-job-1", 1)
    assert updates[-1] == ("done", "AssemblyAI transcription complete!")
    assert fake.released == ["fake-job-1"]
    handle.engine.dispose()


async def test_done_run_short_circuits_unless_forced(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    fake = _FakeTranscriber()
    svc = _service(handle, meetings_dir, fake)
    first, _ = await _transcribe(svc)

    again, _ = await _transcribe(svc)
    assert fake.calls == 1
    assert again["status"] == "done"
    assert again["transcriptArtifactId"] == first["transcriptArtifactId"]

    await _transcribe(svc, force=True)
    assert fake.calls == 2
    assert _stage_run(handle)["attempts"] == 2
    handle.engine.dispose()


async def test_transcriber_failure_marks_error(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    res, updates = await _transcribe(_service(handle, meetings_dir, _FakeTranscriber(RuntimeError("boom"))))

    assert (res["status"], res["error"], res["jobId"]) == ("error", "boom", "fake-job-1")
    run = _stage_run(handle)
    assert (run["status"], run["last_error"]) == ("error", "boom")
    assert _meeting_error(handle) == "boom"
    assert updates[-1] == ("error", "boom")
    handle.engine.dispose()


@pytest.mark.parametrize("abort", ["signal", "exception"])
async def test_cancellation_marks_cancelled_and_releases_the_job(tmp_path: Path, abort: str) -> None:
    handle, meetings_dir = _seed(tmp_path)
    controller = AbortController()

    def _cancel(job: CloudJob) -> CloudTranscript:
        if abort == "signal":
            controller.abort()
            job.raise_if_aborted()
        raise TranscriptionCancelled()

    fake = _FakeTranscriber(_cancel)
    res, updates = await _transcribe(_service(handle, meetings_dir, fake), signal=controller.signal)

    assert res["status"] == "cancelled"
    assert _stage_run(handle)["status"] == "cancelled"
    assert _meeting_error(handle) is None
    assert fake.released == ["fake-job-1"]
    assert updates[-1] == ("cancelled", "Transcription was cancelled.")
    handle.engine.dispose()


async def test_submitted_job_stays_running(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    res, _ = await _transcribe(_service(handle, meetings_dir, _FakeTranscriber(Submitted("fake-job-1"))))

    assert (res["status"], res["jobId"]) == ("running", "fake-job-1")
    assert _stage_run(handle)["status"] == "running"
    handle.engine.dispose()


async def test_measured_usage_replaces_the_estimate(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    measured = CloudTranscript(_transcript(), usage={"source": "fake:measured", "cost_usd": 0.01})
    res, _ = await _transcribe(_service(handle, meetings_dir, _FakeTranscriber(measured)))

    assert res["status"] == "done"
    assert _usage_sources(handle) == ["fake:measured"]
    handle.engine.dispose()


async def test_transcript_artifact_estimates_usage_by_default(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    res, _ = await _transcribe(_service(handle, meetings_dir, _FakeTranscriber()))

    assert _usage_sources(handle) == [f"transcript:{res['transcriptArtifactId']}"]
    handle.engine.dispose()
