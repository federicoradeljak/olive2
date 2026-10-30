"""Cloud transcription: one run lifecycle behind a transcriber seam.

Each cloud provider is a small ``CloudTranscriber`` adapter that turns a
meeting's audio into a canonical ``Transcript`` (``providers/<name>/transcriber.py``).
``CloudTranscriptionRun`` owns everything around it: loading the meeting and
its recording, the "already done" short-circuit, releasing provider jobs, and
handing the transcript to the persistence callback. Run state (``stage_runs``,
meeting status, terminal progress, the summarize follow-up) goes through the
shared ``TranscriptionRun``, the same lifecycle the local stage chain uses.
"""

from __future__ import annotations

import inspect
import re
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..logging_db import Logger
from ..meeting_storage import MeetingStorage, first_recording
from ..schemas import Transcript, TranscriptionProgressUpdate
from ..workflows import QUEUE_ASSEMBLYAI, QUEUE_MODAL, QUEUE_MUSE, QUEUE_SPEECHMATICS
from ..workflows.transcription_run import CANCELLED_ERROR, TranscriptionRun


@dataclass(frozen=True)
class CloudProviderSpec:
    provider: str
    label: str
    stage: str
    queue: str


CLOUD_PROVIDERS: dict[str, CloudProviderSpec] = {
    spec.provider: spec
    for spec in (
        CloudProviderSpec("speechmatics", "Speechmatics", "speechmatics_transcribe", QUEUE_SPEECHMATICS),
        CloudProviderSpec("assemblyai", "AssemblyAI", "assemblyai_transcribe", QUEUE_ASSEMBLYAI),
        CloudProviderSpec("muse", "Muse", "muse_transcribe", QUEUE_MUSE),
        CloudProviderSpec("modal", "Modal", "modal_transcribe", QUEUE_MODAL),
    )
}


class TranscriptionCancelled(Exception):
    """Raised by a transcriber when the run's abort signal fired."""


def signal_aborted(signal: Any) -> bool:
    if signal is None:
        return False
    if getattr(signal, "aborted", False):
        return True
    is_set = getattr(signal, "is_set", None)
    return bool(callable(is_set) and is_set())


def title_implies_two_speakers(title: str | None) -> bool:
    return bool(re.search(r"1[:\-_/]?1|1-on-1|one-on-one|interview", title or "", re.I))


async def emit_progress_update(on_progress: Any, update: TranscriptionProgressUpdate) -> None:
    if callable(on_progress):
        r = on_progress(update)
        if inspect.isawaitable(r):
            await r


@dataclass
class CloudJob:
    """What a transcriber gets for one run."""

    meeting: Mapping[str, Any]
    recording: Mapping[str, Any]
    audio_path: str
    stage_run_id: str
    options: Mapping[str, Any]
    job_id: str = ""
    _on_job_id: Callable[[str], None] = field(default=lambda _job_id: None, repr=False)

    @property
    def meeting_id(self) -> str:
        return str(self.meeting["id"])

    @property
    def signal(self) -> Any:
        return self.options.get("signal")

    @property
    def additional_vocab(self) -> Any:
        return self.options.get("additionalVocab") or self.options.get("additional_vocab")

    def aborted(self) -> bool:
        return signal_aborted(self.signal)

    def raise_if_aborted(self) -> None:
        if self.aborted():
            raise TranscriptionCancelled()

    def set_job_id(self, job_id: str) -> None:
        """Record the provider's job id on the stage run as soon as it is known."""
        self.job_id = job_id
        self._on_job_id(job_id)

    async def progress(self, stage: str, percent: float, message: str, **extra: Any) -> None:
        await emit_progress_update(
            self.options.get("onProgress"),
            TranscriptionProgressUpdate(
                stage=stage,  # type: ignore[arg-type]
                percent=float(round(percent)),
                message=message,
                **extra,
            ),
        )


@dataclass
class CloudTranscript:
    transcript: Transcript
    # Provider payload the speaker persistence understands (Speechmatics json-v2).
    raw_payload: dict[str, Any] | None = None
    # Measured spend for ``record_transcription_usage``; when set, the run
    # records it instead of estimating spend from the transcript artifact.
    usage: dict[str, Any] | None = None


@dataclass
class Submitted:
    """The provider accepted the job and will call back (Speechmatics webhook)."""

    job_id: str


class CloudTranscriber(Protocol):
    spec: CloudProviderSpec

    async def transcribe(self, job: CloudJob) -> CloudTranscript | Submitted: ...

    async def release(self, job_id: str) -> None:
        """Free provider-side resources after completion or cancellation."""
        ...


# Persists a finished transcript (artifacts + speakers) and returns its artifact
# ids, or None when the run was cancelled before anything was written.
PersistTranscript = Callable[..., Awaitable[dict[str, Any] | None]]


class CloudTranscriptionRun:
    def __init__(
        self,
        *,
        db: Engine,
        meetings_dir: str,
        logger: Logger,
        lifecycle: TranscriptionRun,
        persist: PersistTranscript,
        on_job_id: Callable[[str, str, str], None] | None = None,
    ) -> None:
        self.db = db
        self.meetings_dir = meetings_dir
        self.logger = logger
        self.lifecycle = lifecycle
        self._persist = persist
        self._on_job_id = on_job_id

    async def run(
        self,
        transcriber: CloudTranscriber,
        meeting_id: str,
        options: Mapping[str, Any],
    ) -> dict[str, Any]:
        spec = transcriber.spec
        meeting, recording, stage_run = self._load(meeting_id, spec.stage)
        audio_file = MeetingStorage(self.meetings_dir).audio_path(meeting, recording)
        if audio_file is None:
            raise FileNotFoundError(f"Audio file not found on disk for meeting {meeting_id}")

        if stage_run and stage_run["status"] == "done" and not options.get("force"):
            return {
                "stageRunId": stage_run["id"],
                "jobId": stage_run.get("provider_job_id") or "",
                "status": "done",
                "transcriptArtifactId": self._existing_transcript_artifact(meeting_id, spec.provider),
            }

        stage_run_id = self.lifecycle.start(meeting_id, spec.stage)
        job = CloudJob(
            meeting=meeting,
            recording=recording,
            audio_path=str(audio_file),
            stage_run_id=stage_run_id,
            options=options,
            _on_job_id=lambda job_id: self._record_job_id(meeting_id, spec.stage, stage_run_id, job_id),
        )

        try:
            job.raise_if_aborted()
            outcome = await transcriber.transcribe(job)
        except TranscriptionCancelled:
            await self._release(transcriber, job.job_id)
            return await self._cancelled(spec, meeting_id, stage_run_id, job.job_id, options)
        except Exception as exc:
            err_msg = str(exc)
            await self.lifecycle.fail(meeting_id, spec.stage, err_msg, on_progress=options.get("onProgress"))
            return {"stageRunId": stage_run_id, "jobId": job.job_id, "status": "error", "error": err_msg}

        if isinstance(outcome, Submitted):
            return {"stageRunId": stage_run_id, "jobId": outcome.job_id, "status": "running"}
        return await self.finish(transcriber, meeting_id, stage_run_id, job.job_id, outcome, options)

    async def finish(
        self,
        transcriber: CloudTranscriber,
        meeting_id: str,
        stage_run_id: str,
        job_id: str,
        result: CloudTranscript,
        options: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persist a finished transcript (also the Speechmatics webhook's entry point)."""
        spec = transcriber.spec
        opts = options or {}
        if result.usage is not None:
            self._record_usage(spec.provider, meeting_id, result)
        artifacts = await self._persist(
            meeting_id,
            result.transcript,
            spec.provider,
            raw_payload=result.raw_payload,
            options=dict(opts),
            estimate_usage=result.usage is None,
        )
        await self._release(transcriber, job_id)
        if artifacts is None:
            return await self._cancelled(spec, meeting_id, stage_run_id, job_id, opts)
        await self.lifecycle.complete(
            meeting_id,
            spec.stage,
            transcript_artifact_id=artifacts["transcriptArtifactId"],
            job_id=job_id or None,
            message=f"{spec.label} transcription complete!",
            on_progress=opts.get("onProgress"),
        )
        return {"stageRunId": stage_run_id, "jobId": job_id, "status": "done", **artifacts}

    def _load(
        self, meeting_id: str, stage: str
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any] | None]:
        with self.db.connect() as conn:
            meeting = (
                conn.execute(text("SELECT * FROM meetings WHERE id = :id"), {"id": meeting_id})
                .mappings()
                .first()
            )
            if not meeting:
                raise ValueError(f"Meeting not found: {meeting_id}")
            recording = first_recording(conn, meeting_id)
            if not recording:
                raise ValueError(f"No recording found for meeting {meeting_id}")
            stage_run = (
                conn.execute(
                    text("SELECT * FROM stage_runs WHERE meeting_id = :mid AND stage = :stage LIMIT 1"),
                    {"mid": meeting_id, "stage": stage},
                )
                .mappings()
                .first()
            )
        return dict(meeting), recording, dict(stage_run) if stage_run else None

    def _existing_transcript_artifact(self, meeting_id: str, provider: str) -> str | None:
        with self.db.connect() as conn:
            row = (
                conn.execute(
                    text(
                        """
                        SELECT id FROM artifacts
                        WHERE meeting_id = :mid AND provider = :prov AND kind = 'transcript' AND format = 'json'
                        LIMIT 1
                        """
                    ),
                    {"mid": meeting_id, "prov": provider},
                )
                .mappings()
                .first()
            )
        return str(row["id"]) if row else None

    def _record_job_id(self, meeting_id: str, stage: str, stage_run_id: str, job_id: str) -> None:
        self.lifecycle.record_job_id(meeting_id, stage, job_id)
        if self._on_job_id is not None:
            self._on_job_id(meeting_id, stage_run_id, job_id)

    def _record_usage(self, provider: str, meeting_id: str, result: CloudTranscript) -> None:
        try:
            from .usage import record_transcription_usage

            record_transcription_usage(
                self.db,
                meeting_id=meeting_id,
                provider=provider,
                created_at=self.lifecycle.now(),
                **(result.usage or {}),
            )
        except Exception as exc:
            self.logger.warn(
                "Could not record transcription usage",
                {"meetingId": meeting_id, "provider": provider, "error": str(exc)},
            )

    async def _release(self, transcriber: CloudTranscriber, job_id: str) -> None:
        if not job_id:
            return
        try:
            await transcriber.release(job_id)
        except Exception as exc:
            self.logger.warn(
                f"Failed to release {transcriber.spec.label} job",
                {"jobId": job_id, "error": str(exc)},
            )

    async def _cancelled(
        self,
        spec: CloudProviderSpec,
        meeting_id: str,
        stage_run_id: str,
        job_id: str,
        options: Mapping[str, Any],
    ) -> dict[str, Any]:
        await self.lifecycle.cancel(meeting_id, spec.stage, on_progress=options.get("onProgress"))
        return {"stageRunId": stage_run_id, "jobId": job_id, "status": "cancelled", "error": CANCELLED_ERROR}
