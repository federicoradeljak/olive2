"""Transcription orchestration service for Local & Speechmatics providers (port of transcription/service.ts)."""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import time
import urllib.parse
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..db import DbHandle, get_db
from ..layout import ensure_meeting_folder, meeting_paths
from ..logging_db import Logger
from ..logging_db import logger as default_logger
from ..ml import (
    AbortController,
    DiscoveredSpeakerVoiceprint,
    LocalTranscriptionWorkerRunner,
)
from ..providers.speechmatics import (
    SpeechmaticsClient,
    parse_speechmatics_json_v2,
    transcript_to_text,
)
from ..schemas import EnrolledSpeaker, Transcript, TranscriptionProgressUpdate
from ..workflows import QUEUE_SUMMARIZE, enqueue_stage_job, ensure_dbos_launched_async

STAGE_SPEECHMATICS_TRANSCRIBE = "speechmatics_transcribe"
STAGE_LOCAL_TRANSCRIBE = "local_transcribe"
PROVIDER_SPEECHMATICS = "speechmatics"
PROVIDER_LOCAL = "local"

TranscriptionProviderName = Literal["speechmatics", "local"]


def _parse_json_field(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except Exception:
        return fallback


def _is_placeholder_speaker_name(name: str) -> bool:
    s = name.strip()
    return bool(re.match(r"^speaker\s*\d+$", s, re.I) or re.match(r"^s\d+$", s, re.I))


@dataclass
class _ActiveTranscriptionJob:
    abort_controller: AbortController
    provider: TranscriptionProviderName
    stage_run_id: str | None = None
    job_id: str | None = None


class TranscriptionService:
    def __init__(
        self,
        options: dict[str, Any] | None = None,
        *,
        db: Engine | DbHandle | None = None,
        meetings_dir: str | None = None,
        speechmatics_client: SpeechmaticsClient | None = None,
        local_pipeline: Any = None,
        default_provider: TranscriptionProviderName | None = None,
        logger: Logger | None = None,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
        now: Callable[[], int] | None = None,
        summary_service: Any = None,
        config_dir: str | None = None,
    ) -> None:
        opts = options or {}
        raw_db = db or opts.get("db")
        if isinstance(raw_db, DbHandle):
            self.db: Engine = raw_db.engine
        elif isinstance(raw_db, Engine):
            self.db = raw_db
        else:
            self.db = get_db()

        self.meetings_dir = str(meetings_dir or opts.get("meetingsDir") or opts.get("meetings_dir") or "")
        self.config_dir = config_dir or opts.get("configDir") or opts.get("config_dir")
        passed_sm = speechmatics_client or opts.get("speechmaticsClient") or opts.get("speechmatics_client")
        self.client: SpeechmaticsClient = passed_sm or SpeechmaticsClient()
        self.local_pipeline = (
            local_pipeline
            or opts.get("localPipeline")
            or opts.get("local_pipeline")
            or LocalTranscriptionWorkerRunner()
        )
        self.default_provider: TranscriptionProviderName = (
            default_provider
            or opts.get("defaultProvider")
            or opts.get("default_provider")
            or ("speechmatics" if (passed_sm or os.environ.get("SPEECHMATICS_API_KEY")) else "local")
        )
        self.logger: Logger = logger or opts.get("logger") or default_logger
        self.webhook_url: str | None = webhook_url or opts.get("webhookUrl") or opts.get("webhook_url")
        self.webhook_secret: str | None = (
            webhook_secret or opts.get("webhookSecret") or opts.get("webhook_secret")
        )
        self.now: Callable[[], int] = now or opts.get("now") or (lambda: int(time.time() * 1000))
        self.summary_service = summary_service or opts.get("summaryService") or opts.get("summary_service")
        self._active_jobs: dict[str, _ActiveTranscriptionJob] = {}
        self._active_progress: dict[str, TranscriptionProgressUpdate] = {}
        self._progress_listeners: dict[str, set[Callable[[TranscriptionProgressUpdate], Any]]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    @property
    def speechmatics(self) -> SpeechmaticsClient:
        return self.client

    @property
    def local(self) -> Any:
        return self.local_pipeline

    def emit_progress(self, meeting_id: str, update: TranscriptionProgressUpdate | dict[str, Any]) -> None:
        upd = (
            update
            if isinstance(update, TranscriptionProgressUpdate)
            else TranscriptionProgressUpdate.model_validate(update)
        )
        self._active_progress[meeting_id] = upd
        try:
            current_loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
            self._loop = current_loop
        except RuntimeError:
            current_loop = None
        target_loop = current_loop or self._loop

        if upd.stage in ("done", "error", "cancelled") and target_loop and not target_loop.is_closed():

            def _cleanup() -> None:
                if self._active_progress.get(meeting_id) is upd:
                    self._active_progress.pop(meeting_id, None)

            target_loop.call_soon_threadsafe(lambda: target_loop.call_later(10.0, _cleanup))

        listeners = self._progress_listeners.get(meeting_id)
        if listeners:
            for listener in list(listeners):
                try:
                    res = listener(upd)
                    if asyncio.iscoroutine(res):
                        if current_loop is not None:
                            current_loop.create_task(res)
                        elif target_loop is not None and not target_loop.is_closed():
                            asyncio.run_coroutine_threadsafe(res, target_loop)
                        else:
                            res.close()
                except Exception:
                    pass

    emitProgress = emit_progress

    def get_transcription_progress(self, meeting_id: str) -> TranscriptionProgressUpdate | None:
        return self._active_progress.get(meeting_id)

    getTranscriptionProgress = get_transcription_progress

    def get_all_active_transcription_progress(self) -> dict[str, dict[str, Any]]:
        return {mid: prog.model_dump(exclude_none=True) for mid, prog in self._active_progress.items()}

    getAllActiveTranscriptionProgress = get_all_active_transcription_progress

    def subscribe_transcription_progress(
        self,
        meeting_id: str,
        listener: Callable[[TranscriptionProgressUpdate], Any],
    ) -> Callable[[], None]:
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            pass
        s = self._progress_listeners.setdefault(meeting_id, set())
        s.add(listener)

        def _unsub() -> None:
            s.discard(listener)
            if not s:
                self._progress_listeners.pop(meeting_id, None)

        return _unsub

    subscribeTranscriptionProgress = subscribe_transcription_progress

    def set_summary_service(self, service: Any) -> None:
        self.summary_service = service

    setSummaryService = set_summary_service

    def set_default_provider(self, provider: TranscriptionProviderName) -> None:
        self.default_provider = provider

    setDefaultProvider = set_default_provider

    async def _auto_summarize(self, meeting_id: str) -> None:
        if not self.summary_service:
            return
        try:
            with self.db.connect() as conn:
                meeting = (
                    conn.execute(
                        text("SELECT id, primary_summary_artifact_id FROM meetings WHERE id = :id"),
                        {"id": meeting_id},
                    )
                    .mappings()
                    .first()
                )
            if meeting and not meeting.get("primary_summary_artifact_id"):
                self.logger.debug(
                    "Triggering auto-summarization on transcript completion",
                    {"category": "summary", "meetingId": meeting_id},
                )
                gen_fn = getattr(self.summary_service, "generate_summary", None) or getattr(
                    self.summary_service, "generateSummary", None
                )
                if callable(gen_fn):
                    res = gen_fn({"meetingId": meeting_id, "setPrimary": True})
                    if inspect.isawaitable(res):
                        await res
                self.logger.info(
                    "Auto-generated summary on transcript completion",
                    {"category": "summary", "meetingId": meeting_id},
                )
        except Exception as exc:
            self.logger.warn(
                "Auto-summarization skipped or failed on transcript completion",
                {"category": "summary", "meetingId": meeting_id, "error": str(exc)},
            )

    async def _enqueue_auto_summarize(self, meeting_id: str) -> None:
        if not self.summary_service:
            return
        try:
            await ensure_dbos_launched_async(
                config_dir=self.config_dir,
                meetings_dir=self.meetings_dir,
            )
            await enqueue_stage_job(
                QUEUE_SUMMARIZE,
                lambda: self._auto_summarize(meeting_id),
                deduplication_id=f"auto-summarize:{meeting_id}",
            )
        except Exception:
            await self._auto_summarize(meeting_id)

    async def cancel_transcription(self, meeting_id: str) -> dict[str, Any]:
        self.logger.info(
            "Cancelling transcription for meeting",
            {"category": "transcription", "meetingId": meeting_id},
        )
        active = self._active_jobs.get(meeting_id)
        if active:
            active.abort_controller.abort()
            if active.provider == "speechmatics" and active.job_id:
                try:
                    await self.client.delete_job(active.job_id)
                except Exception as exc:
                    self.logger.warn(
                        "Failed to delete Speechmatics job during cancellation",
                        {"jobId": active.job_id, "error": str(exc)},
                    )

        cancel_time = self.now()
        self.emit_progress(
            meeting_id,
            {
                "stage": "cancelled",
                "percent": 0,
                "message": "Transcription was cancelled.",
            },
        )

        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE stage_runs
                    SET status = 'cancelled', last_error = 'Cancelled by user',
                        finished_at = :t, updated_at = :t
                    WHERE meeting_id = :mid AND status = 'running'
                    """
                ),
                {"t": cancel_time, "mid": meeting_id},
            )
            meeting = (
                conn.execute(
                    text("SELECT primary_transcript_artifact_id, status FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
                .mappings()
                .first()
            )
            if meeting:
                next_status = "ready" if meeting.get("primary_transcript_artifact_id") else "pending"
                conn.execute(
                    text(
                        "UPDATE meetings SET status = :st, last_error = NULL, updated_at = :t WHERE id = :id"
                    ),
                    {"st": next_status, "t": cancel_time, "id": meeting_id},
                )

        return {"success": True, "message": "Transcription cancelled successfully"}

    cancelTranscription = cancel_transcription

    async def start_transcription(
        self,
        meeting_id: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = dict(options or {})
        with self.db.connect() as conn:
            meeting = (
                conn.execute(
                    text("SELECT id FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
                .mappings()
                .first()
            )
            if not meeting:
                raise ValueError(f"Meeting not found: {meeting_id}")
            recording = (
                conn.execute(
                    text("SELECT id FROM recordings WHERE meeting_id = :mid ORDER BY created_at ASC LIMIT 1"),
                    {"mid": meeting_id},
                )
                .mappings()
                .first()
            )
            if not recording:
                raise ValueError(f"No recording found for meeting {meeting_id}")

        existing = self._active_jobs.get(meeting_id)
        if existing is not None and not existing.abort_controller.signal.aborted:
            return {
                "status": "running",
                "jobId": existing.job_id or f"active-{meeting_id[:8]}",
                "meetingId": meeting_id,
                "alreadyRunning": True,
            }

        job_id = f"transcribe-{uuid.uuid4().hex[:8]}"
        self.emit_progress(
            meeting_id,
            {
                "stage": "queued",
                "percent": 2,
                "message": "Queued transcription...",
            },
        )

        async def _run_bg() -> None:
            try:
                await self.transcribe_meeting(meeting_id, opts)
            except Exception as exc:
                self.logger.error(
                    "Background transcription failed",
                    {"category": "transcription", "meetingId": meeting_id, "error": str(exc)},
                )

        asyncio.create_task(_run_bg())
        return {
            "status": "running",
            "jobId": job_id,
            "meetingId": meeting_id,
            "alreadyRunning": False,
        }

    startTranscription = start_transcription

    async def transcribe_meeting(
        self,
        meeting_id: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = dict(options or {})
        provider: TranscriptionProviderName = opts.get("provider") or self.default_provider

        self.logger.debug(
            "Initiating meeting transcription",
            {
                "category": "transcription",
                "meetingId": meeting_id,
                "provider": provider,
                "language": opts.get("language"),
                "force": bool(opts.get("force")),
            },
        )

        abort_controller = AbortController()
        ext_signal = opts.get("signal")
        if ext_signal is not None:
            if getattr(ext_signal, "aborted", False) or (
                hasattr(ext_signal, "is_set") and ext_signal.is_set()
            ):
                abort_controller.abort()
            elif hasattr(ext_signal, "add_event_listener"):
                ext_signal.add_event_listener("abort", abort_controller.abort)

        active_job = _ActiveTranscriptionJob(
            abort_controller=abort_controller,
            provider=provider,
        )
        self._active_jobs[meeting_id] = active_job
        user_on_progress = opts.get("onProgress") or opts.get("on_progress")

        async def on_progress_handler(update: Any) -> None:
            self.emit_progress(meeting_id, update)
            if callable(user_on_progress):
                upd_obj = (
                    update
                    if isinstance(update, TranscriptionProgressUpdate)
                    else TranscriptionProgressUpdate.model_validate(update)
                )
                r = user_on_progress(upd_obj)
                if inspect.isawaitable(r):
                    await r

        merged_opts = {
            **opts,
            "signal": abort_controller.signal,
            "onProgress": on_progress_handler,
        }

        try:
            if provider == "local":
                return await self.transcribe_meeting_local(meeting_id, merged_opts)
            return await self.transcribe_meeting_speechmatics(meeting_id, merged_opts)
        finally:
            self._active_jobs.pop(meeting_id, None)

    transcribeMeeting = transcribe_meeting

    async def transcribe_meeting_local(
        self,
        meeting_id: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {}
        with self.db.connect() as conn:
            meeting = (
                conn.execute(
                    text("SELECT * FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
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
                    {"mid": meeting_id, "stage": STAGE_LOCAL_TRANSCRIBE},
                )
                .mappings()
                .first()
            )

        folder = meeting_paths(
            self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"]
        ).folder
        audio_full_path = str(Path(folder) / recording["path"])
        if not Path(audio_full_path).exists():
            raise FileNotFoundError(f"Audio file not found on disk at {audio_full_path}")

        if stage_run and stage_run["status"] == "done" and not opts.get("force"):
            with self.db.connect() as conn:
                existing_art = (
                    conn.execute(
                        text(
                            """
                        SELECT id FROM artifacts
                        WHERE meeting_id = :mid AND provider = :prov AND kind = 'transcript' AND format = 'json'
                        LIMIT 1
                        """
                        ),
                        {"mid": meeting_id, "prov": PROVIDER_LOCAL},
                    )
                    .mappings()
                    .first()
                )
            return {
                "stageRunId": stage_run["id"],
                "jobId": stage_run.get("provider_job_id") or "",
                "status": "done",
                "transcriptArtifactId": existing_art["id"] if existing_art else None,
            }

        stage_run_id = stage_run["id"] if stage_run else str(uuid.uuid4())
        current_time = self.now()

        with self.db.begin() as conn:
            if stage_run:
                conn.execute(
                    text(
                        """
                        UPDATE stage_runs
                        SET status = 'running', attempts = :attempts, last_error = NULL,
                            started_at = :now, updated_at = :now
                        WHERE id = :id
                        """
                    ),
                    {
                        "attempts": int(stage_run["attempts"]) + 1,
                        "now": current_time,
                        "id": stage_run["id"],
                    },
                )
            else:
                conn.execute(
                    text(
                        """
                        INSERT INTO stage_runs (
                          id, meeting_id, stage, status, provider_job_id, attempts,
                          last_error, started_at, finished_at, created_at, updated_at
                        ) VALUES (
                          :id, :mid, :stage, 'running', :job_id, 1,
                          NULL, :now, NULL, :now, :now
                        )
                        """
                    ),
                    {
                        "id": stage_run_id,
                        "mid": meeting_id,
                        "stage": STAGE_LOCAL_TRANSCRIBE,
                        "job_id": f"local-{stage_run_id[:8]}",
                        "now": current_time,
                    },
                )

        try:
            enrolled_speakers = await self._get_enrolled_speakers()
            candidate_speakers: list[str] = list(opts.get("candidateSpeakers") or [])
            title_lower = meeting["title"].lower()
            if not candidate_speakers:
                for spk in enrolled_speakers:
                    parts = [p for p in re.split(r"\s+", spk.name.strip().lower()) if len(p) >= 3]
                    if any(part in title_lower for part in parts):
                        candidate_speakers.append(spk.name)

            expected_speaker_count = opts.get("expectedSpeakerCount")
            if not expected_speaker_count:
                if re.search(r"1[:\-_/]?1|1-on-1|one-on-one|interview", meeting["title"], re.I):
                    expected_speaker_count = 2
                elif candidate_speakers:
                    expected_speaker_count = len(candidate_speakers)

            transcribe_fn = self.local_pipeline.transcribe
            pipe_res: Any = await transcribe_fn(
                {
                    "meetingId": meeting_id,
                    "audioPath": audio_full_path,
                    "language": opts.get("language"),
                    "enrolledSpeakers": enrolled_speakers,
                    "candidateSpeakers": candidate_speakers if candidate_speakers else None,
                    "expectedSpeakerCount": expected_speaker_count,
                    "similarityThreshold": opts.get("similarityThreshold"),
                    "clusteringThreshold": opts.get("clusteringThreshold"),
                    "modelId": opts.get("modelId"),
                    "signal": opts.get("signal"),
                    "onProgress": opts.get("onProgress"),
                    "db": self.db,
                    "now_fn": self.now,
                    "configDir": self.config_dir,
                    "meetingsDir": self.meetings_dir,
                    "workflow_id": f"local-{stage_run_id[:8]}",
                }
            )
            transcript: Transcript = (
                pipe_res.transcript
                if hasattr(pipe_res, "transcript")
                else Transcript.model_validate(pipe_res["transcript"])
            )
            discovered_speakers: list[DiscoveredSpeakerVoiceprint] = (
                pipe_res.discoveredSpeakers
                if hasattr(pipe_res, "discoveredSpeakers")
                else [
                    d if isinstance(d, DiscoveredSpeakerVoiceprint) else DiscoveredSpeakerVoiceprint(**d)
                    for d in pipe_res.get("discoveredSpeakers", [])
                ]
            )

            paths = ensure_meeting_folder(
                meeting_paths(self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"])
            )
            t_text = transcript_to_text(transcript)
            t_json = f"{json.dumps(transcript.model_dump(exclude_none=True), indent=2)}\n"

            json_art_id = await self._ensure_artifact(
                meeting["id"],
                recording["id"],
                "transcript",
                "json",
                "transcripts/local.json",
                t_json,
                paths.transcripts_dir,
                PROVIDER_LOCAL,
            )
            txt_art_id = await self._ensure_artifact(
                meeting["id"],
                recording["id"],
                "transcript",
                "txt",
                "transcripts/local.txt",
                f"{t_text}\n",
                paths.transcripts_dir,
                PROVIDER_LOCAL,
            )

            await self._persist_local_discovered_speakers(meeting["id"], json_art_id, discovered_speakers)

            completed_at = self.now()
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
                    {"aid": json_art_id, "now": completed_at, "id": meeting["id"]},
                )
                conn.execute(
                    text(
                        """
                        UPDATE stage_runs
                        SET status = 'done', last_error = NULL,
                            finished_at = :now, updated_at = :now
                        WHERE id = :id
                        """
                    ),
                    {"now": completed_at, "id": stage_run_id},
                )

            asyncio.create_task(self._enqueue_auto_summarize(meeting["id"]))

            self.emit_progress(
                meeting["id"],
                {
                    "stage": "done",
                    "percent": 100,
                    "message": "Transcription completed successfully.",
                },
            )

            return {
                "stageRunId": stage_run_id,
                "jobId": f"local-{stage_run_id[:8]}",
                "status": "done",
                "transcriptArtifactId": json_art_id,
                "transcriptTextArtifactId": txt_art_id,
            }
        except Exception as exc:
            err_msg = str(exc)
            sig = opts.get("signal")
            is_set_fn = getattr(sig, "is_set", None)
            is_cancelled = bool(
                getattr(sig, "aborted", False)
                or (callable(is_set_fn) and is_set_fn())
                or "cancel" in err_msg.lower()
            )
            err_time = self.now()

            self.emit_progress(
                meeting_id,
                {
                    "stage": "cancelled" if is_cancelled else "error",
                    "percent": 0,
                    "message": "Transcription was cancelled." if is_cancelled else err_msg,
                    "error": None if is_cancelled else err_msg,
                },
            )

            if is_cancelled:
                self.logger.info("Local transcription cancelled by user", {"meetingId": meeting_id})
                with self.db.begin() as conn:
                    conn.execute(
                        text(
                            """
                            UPDATE stage_runs
                            SET status = 'cancelled', last_error = 'Cancelled by user',
                                finished_at = :t, updated_at = :t
                            WHERE id = :id
                            """
                        ),
                        {"t": err_time, "id": stage_run_id},
                    )
                    existing_m = (
                        conn.execute(
                            text("SELECT primary_transcript_artifact_id FROM meetings WHERE id = :id"),
                            {"id": meeting_id},
                        )
                        .mappings()
                        .first()
                    )
                    next_st = (
                        "ready"
                        if (existing_m and existing_m.get("primary_transcript_artifact_id"))
                        else "pending"
                    )
                    conn.execute(
                        text(
                            "UPDATE meetings SET status = :st, last_error = NULL, updated_at = :t WHERE id = :id"
                        ),
                        {"st": next_st, "t": err_time, "id": meeting_id},
                    )
                return {
                    "stageRunId": stage_run_id,
                    "jobId": "",
                    "status": "cancelled",
                    "error": "Cancelled by user",
                }

            self.logger.error(
                "Failed to run local transcription", {"meetingId": meeting_id, "error": err_msg}
            )
            with self.db.begin() as conn:
                conn.execute(
                    text(
                        """
                        UPDATE stage_runs
                        SET status = 'error', last_error = :err,
                            finished_at = :t, updated_at = :t
                        WHERE id = :id
                        """
                    ),
                    {"err": err_msg, "t": err_time, "id": stage_run_id},
                )
                conn.execute(
                    text("UPDATE meetings SET last_error = :err, updated_at = :t WHERE id = :id"),
                    {"err": err_msg, "t": err_time, "id": meeting_id},
                )
            return {
                "stageRunId": stage_run_id,
                "jobId": "",
                "status": "error",
                "error": err_msg,
            }

    transcribeMeetingLocal = transcribe_meeting_local

    async def transcribe_meeting_speechmatics(
        self,
        meeting_id: str,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {}
        on_progress = opts.get("onProgress")

        with self.db.connect() as conn:
            meeting = (
                conn.execute(
                    text("SELECT * FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
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
                    {"mid": meeting_id, "stage": STAGE_SPEECHMATICS_TRANSCRIBE},
                )
                .mappings()
                .first()
            )

        folder = meeting_paths(
            self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"]
        ).folder
        audio_full_path = str(Path(folder) / recording["path"])
        if not Path(audio_full_path).exists():
            raise FileNotFoundError(f"Audio file not found on disk at {audio_full_path}")

        if stage_run and stage_run["status"] == "done" and not opts.get("force"):
            with self.db.connect() as conn:
                existing_art = (
                    conn.execute(
                        text(
                            """
                        SELECT id FROM artifacts
                        WHERE meeting_id = :mid AND provider = :prov AND kind = 'transcript' AND format = 'json'
                        LIMIT 1
                        """
                        ),
                        {"mid": meeting_id, "prov": PROVIDER_SPEECHMATICS},
                    )
                    .mappings()
                    .first()
                )
            return {
                "stageRunId": stage_run["id"],
                "jobId": stage_run.get("provider_job_id") or "",
                "status": "done",
                "transcriptArtifactId": existing_art["id"] if existing_art else None,
            }

        if callable(on_progress):
            r = on_progress(
                TranscriptionProgressUpdate(
                    stage="decoding",
                    percent=5,
                    message="Preparing audio and speaker profiles for Speechmatics...",
                )
            )
            if inspect.isawaitable(r):
                await r

        stage_run_id = stage_run["id"] if stage_run else str(uuid.uuid4())
        current_time = self.now()

        speakers = await self._get_enrolled_speakers()
        speaker_configs = [
            {
                "label": s.name,
                "speaker_identifiers": s.providerIds[PROVIDER_SPEECHMATICS],
            }
            for s in speakers
            if s.providerIds.get(PROVIDER_SPEECHMATICS)
        ]

        webhook_url = (
            f"{self.webhook_url}?meetingId={urllib.parse.quote(meeting_id)}"
            f"&stageRunId={urllib.parse.quote(stage_run_id)}"
            if self.webhook_url
            else None
        )

        if callable(on_progress):
            r = on_progress(
                TranscriptionProgressUpdate(
                    stage="uploading",
                    percent=15,
                    message="Uploading audio to Speechmatics Cloud API...",
                )
            )
            if inspect.isawaitable(r):
                await r

        try:
            submit_res = await self.client.submit_job(
                {
                    "audio": {"path": audio_full_path},
                    "filename": Path(recording["path"]).name,
                    "mime": recording["mime"],
                    "language": opts.get("language") or "en",
                    "speakers": speaker_configs if speaker_configs else None,
                    "getSpeakers": True,
                    "webhookUrl": webhook_url,
                    "webhookSecret": self.webhook_secret,
                }
            )
        except Exception as exc:
            err_msg = str(exc)
            self.logger.error(
                "Failed to submit Speechmatics job", {"meetingId": meeting_id, "error": err_msg}
            )
            with self.db.begin() as conn:
                if stage_run:
                    conn.execute(
                        text(
                            """
                            UPDATE stage_runs
                            SET status = 'error', last_error = :err,
                                attempts = :attempts, updated_at = :now
                            WHERE id = :id
                            """
                        ),
                        {
                            "err": err_msg,
                            "attempts": int(stage_run["attempts"]) + 1,
                            "now": current_time,
                            "id": stage_run["id"],
                        },
                    )
                else:
                    conn.execute(
                        text(
                            """
                            INSERT INTO stage_runs (
                              id, meeting_id, stage, status, provider_job_id, attempts,
                              last_error, started_at, finished_at, created_at, updated_at
                            ) VALUES (
                              :id, :mid, :stage, 'error', NULL, 1,
                              :err, :now, :now, :now, :now
                            )
                            """
                        ),
                        {
                            "id": stage_run_id,
                            "mid": meeting_id,
                            "stage": STAGE_SPEECHMATICS_TRANSCRIBE,
                            "err": err_msg,
                            "now": current_time,
                        },
                    )
                conn.execute(
                    text("UPDATE meetings SET last_error = :err, updated_at = :now WHERE id = :id"),
                    {"err": err_msg, "now": current_time, "id": meeting_id},
                )
            if callable(on_progress):
                r = on_progress(
                    TranscriptionProgressUpdate(
                        stage="error",
                        percent=0,
                        message=err_msg,
                        error=err_msg,
                    )
                )
                if inspect.isawaitable(r):
                    await r
            return {
                "stageRunId": stage_run_id,
                "jobId": "",
                "status": "error",
                "error": err_msg,
            }

        job_id = str(submit_res["id"])
        with self.db.begin() as conn:
            if stage_run:
                conn.execute(
                    text(
                        """
                        UPDATE stage_runs
                        SET status = 'running', provider_job_id = :jid,
                            attempts = :attempts, last_error = NULL,
                            started_at = :now, updated_at = :now
                        WHERE id = :id
                        """
                    ),
                    {
                        "jid": job_id,
                        "attempts": int(stage_run["attempts"]) + 1,
                        "now": current_time,
                        "id": stage_run["id"],
                    },
                )
            else:
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
                        """
                    ),
                    {
                        "id": stage_run_id,
                        "mid": meeting_id,
                        "stage": STAGE_SPEECHMATICS_TRANSCRIBE,
                        "jid": job_id,
                        "now": current_time,
                    },
                )

        if callable(on_progress):
            r = on_progress(
                TranscriptionProgressUpdate(
                    stage="transcribing",
                    percent=25,
                    message=f"Job {job_id[:10]}... accepted by Speechmatics. Cloud processing...",
                )
            )
            if inspect.isawaitable(r):
                await r

        cur_active = self._active_jobs.get(meeting_id)
        if cur_active:
            cur_active.stage_run_id = stage_run_id
            cur_active.job_id = job_id

        if opts.get("poll"):
            return await self.poll_until_complete(
                meeting_id,
                stage_run_id,
                job_id,
                int(opts.get("pollIntervalMs") or 2000),
                int(opts.get("maxPollWaitMs") or 180_000),
                on_progress,
                opts.get("signal"),
            )

        return {
            "stageRunId": stage_run_id,
            "jobId": job_id,
            "status": "running",
        }

    transcribeMeetingSpeechmatics = transcribe_meeting_speechmatics

    async def poll_until_complete(
        self,
        meeting_id: str,
        stage_run_id: str,
        job_id: str,
        interval_ms: int = 2000,
        max_wait_ms: int = 180_000,
        on_progress: Callable[[TranscriptionProgressUpdate], Any] | None = None,
        signal: Any = None,
    ) -> dict[str, Any]:
        start_time = self.now()
        poll_count = 0

        while self.now() - start_time < max_wait_ms:
            if getattr(signal, "aborted", False) or (hasattr(signal, "is_set") and signal.is_set()):
                try:
                    await self.client.delete_job(job_id)
                except Exception:
                    pass
                cancel_time = self.now()
                with self.db.begin() as conn:
                    conn.execute(
                        text(
                            """
                            UPDATE stage_runs
                            SET status = 'cancelled', last_error = 'Cancelled by user',
                                finished_at = :t, updated_at = :t
                            WHERE id = :id
                            """
                        ),
                        {"t": cancel_time, "id": stage_run_id},
                    )
                return {
                    "stageRunId": stage_run_id,
                    "jobId": job_id,
                    "status": "cancelled",
                    "error": "Cancelled by user",
                }

            poll_count += 1
            elapsed_ms = self.now() - start_time
            elapsed_sec = int(round(elapsed_ms / 1000.0))
            pct = min(92, int(round(25 + min(67.0, (elapsed_sec / 45.0) * 67.0))))

            if callable(on_progress):
                r = on_progress(
                    TranscriptionProgressUpdate(
                        stage="transcribing",
                        percent=pct,
                        currentMs=elapsed_ms,
                        message=f"Speechmatics cloud processing (poll #{poll_count}, {elapsed_sec}s elapsed)...",
                    )
                )
                if inspect.isawaitable(r):
                    await r

            status = await self.client.get_job(job_id)
            if status.get("status") == "done":
                if callable(on_progress):
                    r = on_progress(
                        TranscriptionProgressUpdate(
                            stage="finalizing",
                            percent=96,
                            message="Downloading transcript JSON & enrolling speaker voiceprints...",
                        )
                    )
                    if inspect.isawaitable(r):
                        await r

                json_v2 = await self.client.get_transcript(job_id, "json-v2")
                res = await self.complete_transcription(meeting_id, stage_run_id, job_id, json_v2)

                if callable(on_progress):
                    r = on_progress(
                        TranscriptionProgressUpdate(
                            stage="done",
                            percent=100,
                            message="Speechmatics transcription complete!",
                        )
                    )
                    if inspect.isawaitable(r):
                        await r
                return res

            if status.get("status") in ("rejected", "deleted"):
                errors = status.get("errors") or []
                err_msg = (
                    "; ".join(e.get("message", "") for e in errors)
                    if errors
                    else f"Speechmatics job {status.get('status')}"
                )
                err_time = self.now()
                with self.db.begin() as conn:
                    conn.execute(
                        text(
                            """
                            UPDATE stage_runs
                            SET status = 'error', last_error = :err, finished_at = :t, updated_at = :t
                            WHERE id = :id
                            """
                        ),
                        {"err": err_msg, "t": err_time, "id": stage_run_id},
                    )
                    conn.execute(
                        text("UPDATE meetings SET last_error = :err, updated_at = :t WHERE id = :id"),
                        {"err": err_msg, "t": err_time, "id": meeting_id},
                    )
                return {
                    "stageRunId": stage_run_id,
                    "jobId": job_id,
                    "status": "error",
                    "error": err_msg,
                }

            await asyncio.sleep(interval_ms / 1000.0)

        timeout_err = f"Speechmatics job timed out after {max_wait_ms}ms"
        timeout_at = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE stage_runs
                    SET status = 'error', last_error = :err, finished_at = :t, updated_at = :t
                    WHERE id = :id
                    """
                ),
                {"err": timeout_err, "t": timeout_at, "id": stage_run_id},
            )
            conn.execute(
                text("UPDATE meetings SET last_error = :err, updated_at = :t WHERE id = :id"),
                {"err": timeout_err, "t": timeout_at, "id": meeting_id},
            )
        return {
            "stageRunId": stage_run_id,
            "jobId": job_id,
            "status": "error",
            "error": timeout_err,
        }

    pollUntilComplete = poll_until_complete

    async def complete_transcription(
        self,
        meeting_id: str,
        stage_run_id: str,
        job_id: str,
        json_v2: dict[str, Any],
    ) -> dict[str, Any]:
        with self.db.connect() as conn:
            meeting = (
                conn.execute(
                    text("SELECT * FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
                .mappings()
                .first()
            )
            if not meeting:
                raise ValueError(f"Meeting {meeting_id} not found")

            recording = (
                conn.execute(
                    text("SELECT id FROM recordings WHERE meeting_id = :mid LIMIT 1"),
                    {"mid": meeting_id},
                )
                .mappings()
                .first()
            )

        canonical = parse_speechmatics_json_v2(json_v2)
        t_text = transcript_to_text(canonical)
        t_json = f"{json.dumps(canonical.model_dump(exclude_none=True), indent=2)}\n"

        paths = ensure_meeting_folder(
            meeting_paths(self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"])
        )

        rec_id = recording["id"] if recording else None
        json_art_id = await self._ensure_artifact(
            meeting["id"],
            rec_id,
            "transcript",
            "json",
            "transcripts/speechmatics.json",
            t_json,
            paths.transcripts_dir,
            PROVIDER_SPEECHMATICS,
        )
        txt_art_id = await self._ensure_artifact(
            meeting["id"],
            rec_id,
            "transcript",
            "txt",
            "transcripts/speechmatics.txt",
            f"{t_text}\n",
            paths.transcripts_dir,
            PROVIDER_SPEECHMATICS,
        )

        await self._persist_discovered_speakers(meeting["id"], json_art_id, canonical, json_v2)

        completed_at = self.now()
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
                {"aid": json_art_id, "now": completed_at, "id": meeting["id"]},
            )
            conn.execute(
                text(
                    """
                    UPDATE stage_runs
                    SET status = 'done', last_error = NULL,
                        finished_at = :now, updated_at = :now
                    WHERE id = :id
                    """
                ),
                {"now": completed_at, "id": stage_run_id},
            )

        asyncio.create_task(self._enqueue_auto_summarize(meeting["id"]))

        try:
            if job_id:
                await self.client.delete_job(job_id)
        except Exception as cleanup_err:
            self.logger.warn(
                "Failed to delete Speechmatics job after completion",
                {"jobId": job_id, "error": str(cleanup_err)},
            )

        return {
            "stageRunId": stage_run_id,
            "jobId": job_id,
            "status": "done",
            "transcriptArtifactId": json_art_id,
            "transcriptTextArtifactId": txt_art_id,
        }

    completeTranscription = complete_transcription

    async def _ensure_artifact(
        self,
        meeting_id: str,
        recording_id: str | None,
        kind: str,
        fmt: str,
        relative_path: str,
        content: str,
        directory: str,
        provider: str,
    ) -> str:
        dir_path = Path(directory)
        dir_path.mkdir(parents=True, exist_ok=True)
        filename = relative_path.split("/")[-1]
        (dir_path / filename).write_text(content, encoding="utf-8")

        with self.db.begin() as conn:
            existing = (
                conn.execute(
                    text(
                        """
                    SELECT id FROM artifacts
                    WHERE meeting_id = :mid AND provider = :prov AND kind = :kind
                      AND format = :fmt AND path = :path
                    LIMIT 1
                    """
                    ),
                    {
                        "mid": meeting_id,
                        "prov": provider,
                        "kind": kind,
                        "fmt": fmt,
                        "path": relative_path,
                    },
                )
                .mappings()
                .first()
            )

            if existing:
                return existing["id"]

            art_id = str(uuid.uuid4())
            conn.execute(
                text(
                    """
                    INSERT INTO artifacts (
                      id, meeting_id, recording_id, kind, provider, format, path, created_at
                    ) VALUES (
                      :id, :mid, :rid, :kind, :prov, :fmt, :path, :now
                    )
                    """
                ),
                {
                    "id": art_id,
                    "mid": meeting_id,
                    "rid": recording_id,
                    "kind": kind,
                    "prov": provider,
                    "fmt": fmt,
                    "path": relative_path,
                    "now": self.now(),
                },
            )
            return art_id

    async def _persist_local_discovered_speakers(
        self,
        meeting_id: str,
        evidence_artifact_id: str,
        discovered_speakers: list[DiscoveredSpeakerVoiceprint],
    ) -> None:
        current_time = self.now()
        with self.db.begin() as conn:
            for disc in discovered_speakers:
                all_speakers = conn.execute(text("SELECT * FROM speakers")).mappings().all()
                norm_name = disc.name.strip().lower()
                existing = next(
                    (s for s in all_speakers if s["name"].strip().lower() == norm_name),
                    None,
                )
                speaker_id = (
                    existing["id"] if existing else (disc.speakerId if disc.isEnrolled else str(uuid.uuid4()))
                )
                if not existing:
                    conn.execute(
                        text(
                            """
                            INSERT INTO speakers (
                              id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                            ) VALUES (:id, :name, '{}', NULL, '[]', :now)
                            """
                        ),
                        {"id": speaker_id, "name": disc.name, "now": current_time},
                    )
                conn.execute(
                    text(
                        """
                        INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                        VALUES (:mid, :sid, :aid)
                        ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET evidence_artifact_id = :aid
                        """
                    ),
                    {"mid": meeting_id, "sid": speaker_id, "aid": evidence_artifact_id},
                )

    async def _persist_discovered_speakers(
        self,
        meeting_id: str,
        evidence_artifact_id: str,
        transcript: Transcript,
        json_v2: dict[str, Any],
    ) -> None:
        speaker_summary_map: dict[str, list[str]] = {}
        for s in json_v2.get("speakers") or []:
            if not isinstance(s, dict):
                continue
            name = str(s.get("label") or s.get("speaker") or "").strip()
            raw_ids = s.get("speaker_identifiers")
            ids = list(raw_ids) if isinstance(raw_ids, (list, set, tuple)) else []
            if name and ids:
                speaker_summary_map[name] = ids

        unique_speakers = {seg.speaker.strip() for seg in transcript.segments if seg.speaker.strip()}
        current_time = self.now()

        with self.db.begin() as conn:
            for name in unique_speakers:
                all_speakers = conn.execute(text("SELECT * FROM speakers")).mappings().all()
                norm_name = name.lower()
                existing = next(
                    (s for s in all_speakers if s["name"].strip().lower() == norm_name),
                    None,
                )
                sm_ids = speaker_summary_map.get(name, [])
                speaker_id = existing["id"] if existing else str(uuid.uuid4())

                if existing:
                    pids = _parse_json_field(existing.get("provider_ids"), {})
                    cur_sm = list(dict.fromkeys([*(pids.get(PROVIDER_SPEECHMATICS) or []), *sm_ids]))
                    pids[PROVIDER_SPEECHMATICS] = cur_sm
                    conn.execute(
                        text("UPDATE speakers SET provider_ids = :pids WHERE id = :id"),
                        {"pids": json.dumps(pids), "id": existing["id"]},
                    )
                else:
                    pids = {PROVIDER_SPEECHMATICS: sm_ids} if sm_ids else {}
                    is_placeholder = _is_placeholder_speaker_name(name)
                    enrolled_at = current_time if (not is_placeholder and sm_ids) else None
                    conn.execute(
                        text(
                            """
                            INSERT INTO speakers (
                              id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                            ) VALUES (:id, :name, :pids, :enrolled_at, '[]', :now)
                            """
                        ),
                        {
                            "id": speaker_id,
                            "name": name,
                            "pids": json.dumps(pids),
                            "enrolled_at": enrolled_at,
                            "now": current_time,
                        },
                    )

                conn.execute(
                    text(
                        """
                        INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                        VALUES (:mid, :sid, :aid)
                        ON CONFLICT(meeting_id, speaker_id) DO UPDATE SET evidence_artifact_id = :aid
                        """
                    ),
                    {"mid": meeting_id, "sid": speaker_id, "aid": evidence_artifact_id},
                )

    async def _get_enrolled_speakers(self) -> list[EnrolledSpeaker]:
        if self.config_dir:
            try:
                from .speakers import SpeakerService

                spk_svc = SpeakerService(
                    db=self.db,
                    config_dir=self.config_dir,
                    meetings_dir=self.meetings_dir,
                    logger=self.logger,
                )
                await spk_svc.ensure_embedding_model_current()
            except Exception as exc:
                self.logger.warn(
                    "Failed to ensure speaker embedding model current before transcription",
                    {"category": "speakers", "error": str(exc)},
                )

        with self.db.connect() as conn:
            rows = conn.execute(text("SELECT * FROM speakers")).mappings().all()
        out: list[EnrolledSpeaker] = []
        for r in rows:
            name = str(r["name"]).strip()
            if _is_placeholder_speaker_name(name):
                continue
            out.append(
                EnrolledSpeaker(
                    id=r["id"],
                    name=r["name"],
                    providerIds=_parse_json_field(r.get("provider_ids"), {}),
                )
            )
        return out
