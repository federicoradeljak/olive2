"""Shared helpers for driving cloud transcription through a fake transcriber."""

from __future__ import annotations

import inspect
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from olive.layout import meeting_paths
from olive.schemas import Transcript, TranscriptSegment
from olive.services.cloud_transcription import (
    CLOUD_PROVIDERS,
    CloudJob,
    CloudTranscript,
    Submitted,
)

SEED_TIME = 1_700_000_000_000


def seed_cloud_meeting(engine: Engine, meetings_dir: str, meeting_id: str) -> None:
    """A meeting with one recording whose audio file exists on disk."""
    paths = meeting_paths(meetings_dir, SEED_TIME, "Cloud Meeting", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/test.m4a").write_bytes(b"fake audio bytes")
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id, last_error, created_at, updated_at)
                VALUES (:id, 'Cloud Meeting', :now, :end, 'upload', 'ready', '[]', NULL, NULL, NULL, :now, :now)
                """
            ),
            {"id": meeting_id, "now": SEED_TIME, "end": SEED_TIME + 5000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at)
                VALUES (:rid, :mid, 'audio/test.m4a', 'audio/mp4', 5000, 16, :sha, 'upload', NULL, :now)
                """
            ),
            {"rid": f"rec-{meeting_id}", "mid": meeting_id, "sha": f"sha-{meeting_id}", "now": SEED_TIME},
        )


def short_transcript() -> Transcript:
    return Transcript(
        segments=[TranscriptSegment(speaker="Speaker 1", startMs=0, endMs=1000, text="Hello there.")],
        durationMs=1000,
    )


class FakeTranscriber:
    """Records each job's options; ``outcome`` is a result, an exception, or ``[async] f(job)``."""

    def __init__(self, provider: str = "assemblyai", outcome: Any = None) -> None:
        self.spec = CLOUD_PROVIDERS[provider]
        self.outcome: Any = outcome if outcome is not None else CloudTranscript(short_transcript())
        self.options: list[dict[str, Any]] = []
        self.released: list[str] = []

    @property
    def calls(self) -> int:
        return len(self.options)

    async def transcribe(self, job: CloudJob) -> CloudTranscript | Submitted:
        self.options.append(dict(job.options))
        job.set_job_id("fake-job-1")
        await job.progress("transcribing", 40, "Working...")
        outcome: Any = self.outcome
        if isinstance(outcome, BaseException):
            raise outcome
        if isinstance(outcome, CloudTranscript | Submitted):
            return outcome
        result = outcome(job)
        return await result if inspect.isawaitable(result) else result

    async def release(self, job_id: str) -> None:
        self.released.append(job_id)
