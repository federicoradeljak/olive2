"""The cloud run lifecycle, driven through TranscriptionService with a fake transcriber."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from cloud_transcription_helpers import FakeTranscriber, seed_cloud_meeting, short_transcript
from olive.db import create_db
from olive.ml.worker import AbortController
from olive.services.cloud_transcription import (
    CLOUD_PROVIDERS,
    CloudJob,
    CloudTranscript,
    Submitted,
    TranscriptionCancelled,
)
from olive.services.transcription import TranscriptionService

MEETING_ID = "m-cloud-1"
STAGE = CLOUD_PROVIDERS["assemblyai"].stage


def _seed(tmp_path: Path) -> tuple[Any, str]:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    seed_cloud_meeting(handle.engine, meetings_dir, MEETING_ID)
    return handle, meetings_dir


def _service(handle: Any, meetings_dir: str, transcriber: FakeTranscriber) -> TranscriptionService:
    return TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "now": lambda: 1_700_000_001_000,
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


def _meeting_status(handle: Any) -> str:
    with handle.engine.connect() as conn:
        return str(
            conn.execute(text("SELECT status FROM meetings WHERE id = :id"), {"id": MEETING_ID}).scalar()
        )


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
    fake = FakeTranscriber()
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
    fake = FakeTranscriber()
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
    res, updates = await _transcribe(
        _service(handle, meetings_dir, FakeTranscriber(outcome=RuntimeError("boom")))
    )

    assert (res["status"], res["error"], res["jobId"]) == ("error", "boom", "fake-job-1")
    run = _stage_run(handle)
    assert (run["status"], run["last_error"]) == ("error", "boom")
    assert _meeting_error(handle) == "boom"
    assert _meeting_status(handle) == "error"
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

    fake = FakeTranscriber(outcome=_cancel)
    res, updates = await _transcribe(_service(handle, meetings_dir, fake), signal=controller.signal)

    assert res["status"] == "cancelled"
    assert _stage_run(handle)["status"] == "cancelled"
    assert _meeting_error(handle) is None
    assert fake.released == ["fake-job-1"]
    assert updates[-1] == ("cancelled", "Transcription was cancelled.")
    handle.engine.dispose()


async def test_cancel_transcription_releases_the_running_job(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)

    async def _cancel_from_outside(job: CloudJob) -> CloudTranscript:
        await svc.cancel_transcription(MEETING_ID)
        job.raise_if_aborted()
        raise AssertionError("cancel_transcription did not abort the run")

    fake = FakeTranscriber(outcome=_cancel_from_outside)
    svc = _service(handle, meetings_dir, fake)
    res, _ = await _transcribe(svc)

    assert res["status"] == "cancelled"
    assert set(fake.released) == {"fake-job-1"}
    handle.engine.dispose()


async def test_submitted_job_stays_running(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    res, _ = await _transcribe(
        _service(handle, meetings_dir, FakeTranscriber(outcome=Submitted("fake-job-1")))
    )

    assert (res["status"], res["jobId"]) == ("running", "fake-job-1")
    assert _stage_run(handle)["status"] == "running"
    handle.engine.dispose()


async def test_measured_usage_replaces_the_estimate(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    measured = CloudTranscript(short_transcript(), usage={"source": "fake:measured", "cost_usd": 0.01})
    res, _ = await _transcribe(_service(handle, meetings_dir, FakeTranscriber(outcome=measured)))

    assert res["status"] == "done"
    assert _usage_sources(handle) == ["fake:measured"]
    handle.engine.dispose()


async def test_transcript_artifact_estimates_usage_by_default(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    res, _ = await _transcribe(_service(handle, meetings_dir, FakeTranscriber()))

    assert _usage_sources(handle) == [f"transcript:{res['transcriptArtifactId']}"]
    handle.engine.dispose()


async def test_meeting_is_processing_while_the_run_is_active(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    seen: list[str] = []

    def _observe(_job: CloudJob) -> CloudTranscript:
        seen.append(_meeting_status(handle))
        return CloudTranscript(short_transcript())

    res, _ = await _transcribe(_service(handle, meetings_dir, FakeTranscriber(outcome=_observe)))

    assert res["status"] == "done"
    assert seen == ["processing"]
    assert _meeting_status(handle) == "ready"
    handle.engine.dispose()


async def test_completion_awaits_the_durable_summarize_enqueue(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    svc = _service(handle, meetings_dir, FakeTranscriber())
    enqueued: list[str] = []

    async def _enqueue(meeting_id: str) -> None:
        enqueued.append(meeting_id)

    svc._enqueue_auto_summarize = _enqueue  # type: ignore[method-assign]
    await _transcribe(svc)

    # Awaited inside the run, not scheduled as a bare task.
    assert enqueued == [MEETING_ID]
    handle.engine.dispose()


async def test_callback_completion_reports_done_progress(tmp_path: Path) -> None:
    handle, meetings_dir = _seed(tmp_path)
    fake = FakeTranscriber(outcome=Submitted("fake-job-1"))
    svc = _service(handle, meetings_dir, fake)
    submitted, _ = await _transcribe(svc)

    # A provider callback (Speechmatics webhook) finishes without a caller's onProgress.
    res = await svc._cloud_run().finish(
        fake, MEETING_ID, submitted["stageRunId"], "fake-job-1", CloudTranscript(short_transcript())
    )

    assert res["status"] == "done"
    progress = svc.get_transcription_progress(MEETING_ID)
    assert progress is not None and progress.stage == "done"
    handle.engine.dispose()
