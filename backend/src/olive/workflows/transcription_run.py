"""One owner for a transcription run's lifecycle, local or cloud.

A run is the meeting's run row in ``stage_runs`` (``local_transcribe`` or a
cloud provider's ``*_transcribe`` stage) plus the meeting's ``status`` /
``last_error``. Every rule about how a run starts, completes, fails or is
cancelled lives here, so the local stage chain and the cloud transcribers
cannot drift apart:

- start: the run row is ``running``; a meeting without a transcript shows
  ``processing``.
- complete: the transcript becomes primary, the meeting is ``ready``, the run
  row is ``done``, ``done`` progress is emitted, then ``after_complete`` (the
  durable auto-summarize enqueue) runs.
- fail / cancel: only an active run row moves, optionally guarded by the job id
  that owns it, so a late or superseded run cannot overwrite a newer one. A
  ``processing`` meeting falls back to ``error`` (failed, no transcript),
  ``ready`` (it has a transcript) or ``pending`` (cancelled, no transcript).

Persisting artifacts and speakers stays with the callers; this module only
records state and emits the terminal progress.
"""

from __future__ import annotations

import inspect
import uuid
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from sqlalchemy import Connection, Engine, text

from ..logging_db import Logger
from ..logging_db import logger as default_logger
from ..schemas import TranscriptionProgressUpdate

CANCELLED_MESSAGE = "Transcription was cancelled."
CANCELLED_ERROR = "Cancelled by user"

ACTIVE_STATUSES = ("pending", "queued", "running")

ProgressFn = Callable[..., Any]


async def _call_progress(fn: ProgressFn | None, *args: Any) -> None:
    if not callable(fn):
        return
    res = fn(*args)
    if inspect.isawaitable(res):
        await res


class TranscriptionRun:
    def __init__(
        self,
        db: Engine,
        *,
        now: Callable[[], int],
        progress: Callable[[str, dict[str, Any]], Any] | None = None,
        after_complete: Callable[[str], Awaitable[None]] | None = None,
        logger: Logger = default_logger,
    ) -> None:
        self.db = db
        self.now = now
        self.progress = progress
        self.after_complete = after_complete
        self.logger = logger

    async def emit(
        self,
        meeting_id: str,
        update: Mapping[str, Any],
        on_progress: ProgressFn | None = None,
    ) -> None:
        """Send ``update`` to the caller's ``on_progress`` or else the process-wide sink."""
        try:
            if on_progress is not None:
                await _call_progress(on_progress, TranscriptionProgressUpdate.model_validate(dict(update)))
            else:
                await _call_progress(self.progress, meeting_id, dict(update))
        except Exception as exc:
            self.logger.warn(
                "Failed to emit transcription progress",
                {"category": "transcription", "meetingId": meeting_id, "error": str(exc)},
            )

    def start(
        self,
        meeting_id: str,
        stage: str,
        *,
        job_id: str | None = None,
        conn: Connection | None = None,
    ) -> str:
        """Mark the run row ``running`` and return its id (kept across re-runs)."""
        if conn is None:
            with self.db.begin() as own:
                return self.start(meeting_id, stage, job_id=job_id, conn=own)
        now = self.now()
        conn.execute(
            text(
                """
                INSERT INTO stage_runs (
                  id, meeting_id, stage, status, provider_job_id, attempts,
                  last_error, started_at, finished_at, created_at, updated_at
                ) VALUES (
                  :id, :mid, :stage, 'running', :jid, 1,
                  NULL, :now, NULL, :now, :now
                )
                ON CONFLICT(meeting_id, stage) DO UPDATE SET
                  status = 'running', provider_job_id = excluded.provider_job_id,
                  attempts = stage_runs.attempts + 1, last_error = NULL,
                  started_at = excluded.started_at, finished_at = NULL,
                  updated_at = excluded.updated_at
                """
            ),
            {"id": str(uuid.uuid4()), "mid": meeting_id, "stage": stage, "jid": job_id, "now": now},
        )
        conn.execute(
            text(
                """
                UPDATE meetings
                SET status = 'processing', last_error = NULL, updated_at = :now
                WHERE id = :mid AND primary_transcript_artifact_id IS NULL
                """
            ),
            {"now": now, "mid": meeting_id},
        )
        return str(
            conn.execute(
                text("SELECT id FROM stage_runs WHERE meeting_id = :mid AND stage = :stage"),
                {"mid": meeting_id, "stage": stage},
            ).scalar_one()
        )

    def record_job_id(self, meeting_id: str, stage: str, job_id: str) -> None:
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE stage_runs SET provider_job_id = :jid, updated_at = :now
                    WHERE meeting_id = :mid AND stage = :stage
                    """
                ),
                {"jid": job_id or None, "now": self.now(), "mid": meeting_id, "stage": stage},
            )

    def status(self, meeting_id: str, stage: str) -> str | None:
        with self.db.connect() as conn:
            row = conn.execute(
                text("SELECT status FROM stage_runs WHERE meeting_id = :mid AND stage = :stage"),
                {"mid": meeting_id, "stage": stage},
            ).scalar()
        return str(row) if row is not None else None

    async def complete(
        self,
        meeting_id: str,
        stage: str,
        *,
        transcript_artifact_id: str,
        job_id: str | None = None,
        message: str = "Transcription completed successfully.",
        on_progress: ProgressFn | None = None,
    ) -> None:
        """Make the transcript primary and close the run (idempotent)."""
        now = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE meetings
                    SET primary_transcript_artifact_id = :aid, status = 'ready',
                        last_error = NULL, updated_at = :now
                    WHERE id = :id
                    """
                ),
                {"aid": transcript_artifact_id, "now": now, "id": meeting_id},
            )
            conn.execute(
                text(
                    """
                    INSERT INTO stage_runs (
                      id, meeting_id, stage, status, provider_job_id, attempts,
                      last_error, started_at, finished_at, created_at, updated_at
                    ) VALUES (
                      :id, :mid, :stage, 'done', :jid, 0,
                      NULL, :now, :now, :now, :now
                    )
                    ON CONFLICT(meeting_id, stage) DO UPDATE SET
                      status = 'done', last_error = NULL,
                      provider_job_id = COALESCE(stage_runs.provider_job_id, excluded.provider_job_id),
                      finished_at = excluded.finished_at, updated_at = excluded.updated_at
                    """
                ),
                {"id": str(uuid.uuid4()), "mid": meeting_id, "stage": stage, "jid": job_id, "now": now},
            )
        await self.emit(meeting_id, {"stage": "done", "percent": 100, "message": message}, on_progress)
        if self.after_complete is not None:
            await self.after_complete(meeting_id)

    async def fail(
        self,
        meeting_id: str,
        stage: str,
        error: str,
        *,
        job_id: str | None = None,
        on_progress: ProgressFn | None = None,
    ) -> bool:
        """Record a failed run; returns False when the run row was not active (or not ours)."""
        changed = self._close(meeting_id, stage, "error", error, job_id=job_id)
        if changed:
            self.logger.error(
                "Transcription failed",
                {"category": "transcription", "meetingId": meeting_id, "stage": stage, "error": error},
            )
            await self.emit(
                meeting_id,
                {"stage": "error", "percent": 0, "message": error, "error": error},
                on_progress,
            )
        return changed

    async def cancel(
        self,
        meeting_id: str,
        stage: str,
        *,
        job_id: str | None = None,
        on_progress: ProgressFn | None = None,
    ) -> bool:
        """Record a cancelled run; a run that already ended keeps its outcome."""
        changed = self._close(meeting_id, stage, "cancelled", CANCELLED_ERROR, job_id=job_id)
        if changed:
            self.logger.info(
                "Transcription cancelled",
                {"category": "transcription", "meetingId": meeting_id, "stage": stage},
            )
            await self.emit(
                meeting_id, {"stage": "cancelled", "percent": 0, "message": CANCELLED_MESSAGE}, on_progress
            )
        return changed

    async def cancel_all(self, meeting_id: str, *, on_progress: ProgressFn | None = None) -> None:
        """User cancel: close every active row of the meeting and drop its checkpoints."""
        now = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE stage_runs
                    SET status = 'cancelled', last_error = :err, finished_at = :t, updated_at = :t
                    WHERE meeting_id = :mid AND status IN ('pending', 'queued', 'running')
                    """
                ),
                {"err": CANCELLED_ERROR, "t": now, "mid": meeting_id},
            )
            conn.execute(text("DELETE FROM stage_checkpoints WHERE meeting_id = :mid"), {"mid": meeting_id})
            self._settle_meeting(conn, meeting_id, "cancelled", None, now)
        await self.emit(
            meeting_id, {"stage": "cancelled", "percent": 0, "message": CANCELLED_MESSAGE}, on_progress
        )

    def _close(self, meeting_id: str, stage: str, status: str, error: str, *, job_id: str | None) -> bool:
        now = self.now()
        guard = " AND provider_job_id = :jid" if job_id else ""
        with self.db.begin() as conn:
            changed = (
                conn.execute(
                    text(
                        f"""
                        UPDATE stage_runs
                        SET status = :st, last_error = :err, finished_at = :t, updated_at = :t
                        WHERE meeting_id = :mid AND stage = :stage
                          AND status IN ('pending', 'queued', 'running'){guard}
                        """
                    ),
                    {"st": status, "err": error, "t": now, "mid": meeting_id, "stage": stage, "jid": job_id},
                ).rowcount
                or 0
            )
            if changed:
                self._settle_meeting(conn, meeting_id, status, error if status == "error" else None, now)
        return changed > 0

    @staticmethod
    def _settle_meeting(conn: Connection, meeting_id: str, outcome: str, error: str | None, now: int) -> None:
        """Move a ``processing`` meeting off it once its run ended without a new transcript."""
        no_transcript_status = "error" if outcome == "error" else "pending"
        conn.execute(
            text(
                """
                UPDATE meetings
                SET status = CASE
                      WHEN status != 'processing' THEN status
                      WHEN primary_transcript_artifact_id IS NOT NULL THEN 'ready'
                      ELSE :fallback END,
                    last_error = :err, updated_at = :now
                WHERE id = :mid
                """
            ),
            {"fallback": no_transcript_status, "err": error, "now": now, "mid": meeting_id},
        )
