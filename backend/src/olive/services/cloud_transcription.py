"""Cloud transcription: one run lifecycle behind a transcriber seam.

Each cloud provider is a small ``CloudTranscriber`` adapter that turns a
meeting's audio into a canonical ``Transcript`` (``providers/<name>/transcriber.py``).
``CloudTranscriptionRun`` owns everything around it: loading the meeting and
its recording, the "already done" short-circuit, the ``stage_runs`` lifecycle,
cancellation, failure bookkeeping, progress, and handing the transcript to the
persistence callback.
"""

from __future__ import annotations

import inspect
import re
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..layout import meeting_paths
from ..logging_db import Logger
from ..schemas import Transcript, TranscriptionProgressUpdate
from ..workflows import QUEUE_ASSEMBLYAI, QUEUE_MODAL, QUEUE_MUSE, QUEUE_SPEECHMATICS

CANCELLED_MESSAGE = "Transcription was cancelled."
CANCELLED_ERROR = "Cancelled by user"


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


CompleteTranscript = Callable[..., Awaitable[dict[str, Any]]]


class CloudTranscriptionRun:
    def __init__(
        self,
        *,
        db: Engine,
        meetings_dir: str,
        now: Callable[[], int],
        logger: Logger,
        complete: CompleteTranscript,
        on_job_id: Callable[[str, str, str], None] | None = None,
    ) -> None:
        self.db = db
        self.meetings_dir = meetings_dir
        self.now = now
        self.logger = logger
        self._complete = complete
        self._on_job_id = on_job_id

    async def run(
        self,
        transcriber: CloudTranscriber,
        meeting_id: str,
        options: Mapping[str, Any],
    ) -> dict[str, Any]:
        spec = transcriber.spec
        meeting, recording, stage_run = self._load(meeting_id, spec.stage)
        folder = meeting_paths(
            self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"]
        ).folder
        audio_path = str(Path(folder) / recording["path"])
        if not Path(audio_path).exists():
            raise FileNotFoundError(f"Audio file not found on disk at {audio_path}")

        if stage_run and stage_run["status"] == "done" and not options.get("force"):
            return {
                "stageRunId": stage_run["id"],
                "jobId": stage_run.get("provider_job_id") or "",
                "status": "done",
                "transcriptArtifactId": self._existing_transcript_artifact(meeting_id, spec.provider),
            }

        stage_run_id = str(stage_run["id"]) if stage_run else str(uuid.uuid4())
        self._mark_running(meeting_id, spec.stage, stage_run_id, stage_run)
        job = CloudJob(
            meeting=meeting,
            recording=recording,
            audio_path=audio_path,
            stage_run_id=stage_run_id,
            options=options,
            _on_job_id=lambda job_id: self._record_job_id(meeting_id, stage_run_id, job_id),
        )

        try:
            job.raise_if_aborted()
            outcome = await transcriber.transcribe(job)
        except TranscriptionCancelled:
            await self._release(transcriber, job.job_id)
            return await self._fail(spec, meeting_id, stage_run_id, job.job_id, options, cancelled=True)
        except Exception as exc:
            return await self._fail(spec, meeting_id, stage_run_id, job.job_id, options, str(exc))

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
        res = await self._complete(
            meeting_id,
            stage_run_id,
            job_id,
            result.transcript,
            spec.provider,
            raw_payload=result.raw_payload,
            options=dict(opts),
            estimate_usage=result.usage is None,
        )
        await self._release(transcriber, job_id)
        if res.get("status") == "cancelled":
            return await self._fail(spec, meeting_id, stage_run_id, job_id, opts, cancelled=True)
        await emit_progress_update(
            opts.get("onProgress"),
            TranscriptionProgressUpdate(
                stage="done", percent=100, message=f"{spec.label} transcription complete!"
            ),
        )
        return res

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
            recording = (
                conn.execute(
                    text("SELECT * FROM recordings WHERE meeting_id = :mid ORDER BY created_at ASC LIMIT 1"),
                    {"mid": meeting_id},
                )
                .mappings()
                .first()
            )
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
        return dict(meeting), dict(recording), dict(stage_run) if stage_run else None

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

    def _mark_running(
        self,
        meeting_id: str,
        stage: str,
        stage_run_id: str,
        stage_run: Mapping[str, Any] | None,
    ) -> None:
        now = self.now()
        with self.db.begin() as conn:
            if stage_run:
                conn.execute(
                    text(
                        """
                        UPDATE stage_runs
                        SET status = 'running', provider_job_id = NULL, attempts = :attempts,
                            last_error = NULL, started_at = :now, finished_at = NULL, updated_at = :now
                        WHERE id = :id
                        """
                    ),
                    {"attempts": int(stage_run["attempts"]) + 1, "now": now, "id": stage_run_id},
                )
            else:
                conn.execute(
                    text(
                        """
                        INSERT INTO stage_runs (
                          id, meeting_id, stage, status, provider_job_id, attempts,
                          last_error, started_at, finished_at, created_at, updated_at
                        ) VALUES (
                          :id, :mid, :stage, 'running', NULL, 1,
                          NULL, :now, NULL, :now, :now
                        )
                        """
                    ),
                    {"id": stage_run_id, "mid": meeting_id, "stage": stage, "now": now},
                )

    def _record_job_id(self, meeting_id: str, stage_run_id: str, job_id: str) -> None:
        with self.db.begin() as conn:
            conn.execute(
                text("UPDATE stage_runs SET provider_job_id = :jid, updated_at = :now WHERE id = :id"),
                {"jid": job_id or None, "now": self.now(), "id": stage_run_id},
            )
        if self._on_job_id is not None:
            self._on_job_id(meeting_id, stage_run_id, job_id)

    def _record_usage(self, provider: str, meeting_id: str, result: CloudTranscript) -> None:
        try:
            from .usage import record_transcription_usage

            record_transcription_usage(
                self.db,
                meeting_id=meeting_id,
                provider=provider,
                created_at=self.now(),
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

    async def _fail(
        self,
        spec: CloudProviderSpec,
        meeting_id: str,
        stage_run_id: str,
        job_id: str,
        options: Mapping[str, Any],
        err_msg: str = CANCELLED_MESSAGE,
        cancelled: bool = False,
    ) -> dict[str, Any]:
        err_time = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE stage_runs
                    SET status = :st, last_error = :err, finished_at = :t, updated_at = :t
                    WHERE id = :id
                    """
                ),
                {
                    "st": "cancelled" if cancelled else "error",
                    "err": CANCELLED_ERROR if cancelled else err_msg,
                    "t": err_time,
                    "id": stage_run_id,
                },
            )
            if not cancelled:
                conn.execute(
                    text("UPDATE meetings SET last_error = :err, updated_at = :t WHERE id = :id"),
                    {"err": err_msg, "t": err_time, "id": meeting_id},
                )
        self.logger.error(f"{spec.label} transcription failed", {"meetingId": meeting_id, "error": err_msg})
        await emit_progress_update(
            options.get("onProgress"),
            TranscriptionProgressUpdate(
                stage="cancelled" if cancelled else "error",
                percent=0,
                message=CANCELLED_MESSAGE if cancelled else err_msg,
                error=None if cancelled else err_msg,
            ),
        )
        return {
            "stageRunId": stage_run_id,
            "jobId": job_id,
            "status": "cancelled" if cancelled else "error",
            "error": CANCELLED_ERROR if cancelled else err_msg,
        }
