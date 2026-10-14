"""Plaud Cloud recording discovery, PCS sync, and audio ingestion poller (port of plaud/poller.ts)."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import math
import re
import time
import urllib.parse
import uuid
from collections.abc import AsyncIterator, Callable, Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..db import DbHandle, get_db
from ..layout import ensure_meeting_folder, meeting_paths
from ..logging_db import Logger
from ..logging_db import logger as default_logger
from ..ml.opus import is_raw_plaud_opus, wrap_raw_opus_bytes
from .retry import (
    compute_retry_delay_ms,
    is_rate_limit_error,
    rate_limit_error_from_response,
    resolve_retry_policy,
    with_rate_limit_retry,
)
from .sdk import (
    NotFoundError,
    alternate_plaud_file_id,
    canonical_plaud_file_id,
    extract_summary_notes,
    parse_transcript_segments,
    segments_to_text,
)

DEFAULT_PAGE_SIZE = 100
DEFAULT_PCS_WAIT_MS = 5 * 60 * 1000
DEFAULT_AUDIO_EXTENSION = "m4a"
PLAUD_PROVIDER = "plaud"


class DuplicateAudioError(Exception):
    def __init__(self, duplicate_of_meeting_id: str) -> None:
        super().__init__(f"Audio hash already belongs to meeting {duplicate_of_meeting_id}")
        self.duplicateOfMeetingId = duplicate_of_meeting_id
        self.duplicate_of_meeting_id = duplicate_of_meeting_id


def _parse_timestamp(value: str | int | float | None, fallback: int) -> int:
    if value is None or value == "":
        return fallback
    try:
        num = float(value)
        if math.isfinite(num):
            return int(round(num * 1000)) if num < 1_000_000_000_000 else int(round(num))
    except (ValueError, TypeError):
        pass
    if isinstance(value, str):
        try:
            iso = value.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso)
            return int(round(dt.timestamp() * 1000))
        except Exception:
            pass
    return fallback


def duration_to_ms(duration: float | int | None) -> int:
    if duration is None or isinstance(duration, bool):
        return 0
    try:
        d = float(duration)
    except (ValueError, TypeError):
        return 0
    if not math.isfinite(d) or d <= 0:
        return 0
    return int(round(d * 1000)) if d < 1000 else int(round(d))


durationToMs = duration_to_ms


def _normalize_speaker_name(name: str) -> str:
    return re.sub(r"\s+", " ", name.strip())


def is_generic_plaud_speaker(name: str | None) -> bool:
    if not name or not name.strip():
        return True
    normalized = name.strip().lower()
    return bool(
        re.match(
            r"^(?:speaker|speakers|spk|participant|person|unknown)(?:[\s_-]*\d+)?$",
            normalized,
        )
    )


isGenericPlaudSpeaker = is_generic_plaud_speaker


def _extension_from_mime(mime: str) -> str | None:
    normalized = mime.split(";", 1)[0].strip().lower()
    extensions = {
        "audio/aac": "aac",
        "audio/flac": "flac",
        "audio/mp4": "m4a",
        "audio/mpeg": "mp3",
        "audio/ogg": "ogg",
        "audio/wav": "wav",
        "audio/webm": "webm",
        "audio/x-m4a": "m4a",
        "audio/x-wav": "wav",
    }
    return extensions.get(normalized)


def _extension_from_url(url: str) -> str | None:
    try:
        ext = Path(urllib.parse.urlparse(url).path).suffix.lstrip(".").lower()
        return ext if re.match(r"^[a-z0-9]{1,8}$", ext) else None
    except Exception:
        return None


def _mime_for_extension(extension: str) -> str:
    mimes = {
        "aac": "audio/aac",
        "flac": "audio/flac",
        "m4a": "audio/mp4",
        "mp3": "audio/mpeg",
        "ogg": "audio/ogg",
        "wav": "audio/wav",
        "webm": "audio/webm",
    }
    return mimes.get(extension, "application/octet-stream")


def clean_plaud_summary_markdown(content: str) -> str:
    if not content:
        return ""
    text_out = content.strip()
    text_out = re.sub(r"^#+\s*Auto_sum_note\s*\n*", "", text_out, flags=re.I)
    text_out = re.sub(r"^Auto_sum_note\s*\n*", "", text_out, flags=re.I)
    text_out = re.sub(r"^(?:[-*_]{3,}\s*\n*)+", "", text_out)
    text_out = re.sub(
        r"^Of course\. Here is the analysis of the conversation transcript you provided\.\s*\n*",
        "",
        text_out,
        flags=re.I,
    )
    text_out = re.sub(r"^(?:[-*_]{3,}\s*\n*)+", "", text_out)
    return text_out.strip()


cleanPlaudSummaryMarkdown = clean_plaud_summary_markdown


def summary_to_markdown(notes: list[dict[str, str]]) -> str:
    if not notes:
        return ""
    sections: list[str] = []
    for note in notes:
        cleaned = clean_plaud_summary_markdown(note.get("content") or "")
        if not cleaned:
            continue
        type_lower = (note.get("type") or "").strip().lower()
        is_auto_sum = type_lower in ("auto_sum_note", "summary", "auto_sum", "")
        if is_auto_sum:
            sections.append(cleaned)
        else:
            raw_heading = (note.get("type") or "").strip() or "Summary"
            heading = raw_heading[0].upper() + raw_heading[1:]
            sections.append(f"## {heading}\n\n{cleaned}")
    return f"{'\n\n'.join(sections)}\n" if sections else ""


summaryToMarkdown = summary_to_markdown


def _content_is_ready(detail: Mapping[str, Any]) -> bool:
    return bool(detail.get("source_list") or detail.get("note_list"))


class _DefaultHttpResponse:
    def __init__(self, status: int, content: bytes, headers: Mapping[str, str]) -> None:
        self.status = status
        self._content = content
        self.headers = {k.lower(): v for k, v in headers.items()}

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    async def arrayBuffer(self) -> bytes:
        return self._content

    async def read(self) -> bytes:
        return self._content


async def _default_fetch(url: str) -> _DefaultHttpResponse:
    async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
        res = await client.get(url)
        return _DefaultHttpResponse(res.status_code, res.content, dict(res.headers))


class PlaudPoller:
    def __init__(self, options: dict[str, Any] | None = None, **kwargs: Any) -> None:
        opts = {**(options or {}), **kwargs}
        raw_db = opts.get("db")
        if isinstance(raw_db, DbHandle):
            self.db: Engine = raw_db.engine
        elif isinstance(raw_db, Engine):
            self.db = raw_db
        else:
            self.db = get_db()

        self.meetings_dir: str = str(opts.get("meetingsDir") or opts.get("meetings_dir") or "")
        self.client: Any = opts.get("client")
        self.transcription_service: Any = opts.get("transcriptionService") or opts.get(
            "transcription_service"
        )
        self.retranscribe_plaud_when_unnamed: bool = bool(
            opts.get("retranscribePlaudWhenUnnamed") or opts.get("retranscribe_plaud_when_unnamed")
        )
        self.auto_transcribe_with_speechmatics: bool = bool(
            opts.get("autoTranscribeWithSpeechmatics") or opts.get("auto_transcribe_with_speechmatics")
        )
        self.now: Callable[[], int] = opts.get("now") or (lambda: int(time.time() * 1000))
        self.fetch_impl: Callable[[str], Any] = (
            opts.get("fetchImpl") or opts.get("fetch_impl") or _default_fetch
        )
        self.logger: Logger = opts.get("logger") or default_logger
        self.page_size: int = int(opts.get("pageSize") or DEFAULT_PAGE_SIZE)
        self.pcs_wait_ms: int = int(opts.get("pcsWaitMs") or DEFAULT_PCS_WAIT_MS)
        self.retry_options: dict[str, Any] = dict(opts.get("retryOptions") or {})

        self._scheduler: AsyncIOScheduler | None = None
        self._in_flight: asyncio.Task[dict[str, Any]] | None = None
        self._background_tasks: set[asyncio.Task[Any]] = set()
        self._connected = False
        self._last_poll_at: int | None = None

    @property
    def oauth(self) -> Any:
        return getattr(self.client, "oauth", None)

    def _log_retry(self, info: dict[str, Any]) -> None:
        self.logger.warn(
            "Plaud API rate limit hit; retrying with backoff",
            {
                "category": "plaud",
                "attempt": info["attempt"],
                "maxRetries": info["maxRetries"],
                "delayMs": info["delayMs"],
                "error": str(info["error"]),
            },
        )
        user_cb = self.retry_options.get("onRetry")
        if callable(user_cb):
            user_cb(info)

    async def _with_plaud_retry(self, operation: Callable[[], Any]) -> Any:
        return await with_rate_limit_retry(
            operation,
            {
                **self.retry_options,
                "onRetry": self._log_retry,
            },
        )

    def start(self, interval_minutes: int) -> None:
        self.stop()
        try:
            self._scheduler = AsyncIOScheduler()
            self._scheduler.add_job(
                self.trigger,
                "interval",
                minutes=max(1, int(interval_minutes)),
                id="plaud_poll",
                replace_existing=True,
            )
            self._scheduler.start()
        except Exception:
            self._scheduler = None
        try:
            asyncio.get_running_loop().create_task(self.trigger())
        except RuntimeError:
            pass

    def stop(self) -> None:
        if self._scheduler is not None:
            try:
                self._scheduler.shutdown(wait=False)
            except Exception:
                pass
            self._scheduler = None

    async def trigger(self) -> dict[str, Any]:
        if self._in_flight is not None and not self._in_flight.done():
            return await self._in_flight

        self.trigger_background()
        if self._in_flight is None:  # pragma: no cover - defensive
            raise RuntimeError("Failed to start Plaud poll cycle")
        return await self._in_flight

    def trigger_background(self) -> bool:
        """Start a poll cycle without waiting for it to finish.

        Returns ``False`` when a cycle is already running so callers can avoid
        queueing duplicate work.
        """
        if self._in_flight is not None and not self._in_flight.done():
            return False
        task = asyncio.create_task(self._run_poll())
        self._in_flight = task
        task.add_done_callback(self._clear_in_flight)
        return True

    triggerBackground = trigger_background

    def _clear_in_flight(self, task: asyncio.Task[Any]) -> None:
        if self._in_flight is task:
            self._in_flight = None

    def _spawn_background(self, coro: Any) -> None:
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    async def get_status(self) -> dict[str, Any]:
        if self._last_poll_at is None:
            with self.db.connect() as conn:
                stored = (
                    conn.execute(text("SELECT value FROM sync_state WHERE key = 'plaud:last_poll_at'"))
                    .mappings()
                    .first()
                )
            if stored and stored.get("value"):
                try:
                    self._last_poll_at = int(stored["value"])
                except ValueError:
                    self._last_poll_at = None

        pcs_pending = await self._pending_count()
        connected = await self._check_connection()
        return {
            "connected": connected,
            "lastPollAt": self._last_poll_at,
            "pcsPending": pcs_pending,
        }

    getStatus = get_status

    async def _check_connection(self) -> bool:
        try:
            get_tok = getattr(self.oauth, "get_access_token", None) or getattr(
                self.oauth, "getAccessToken", None
            )
            if callable(get_tok):
                tok = get_tok()
                if inspect.isawaitable(tok):
                    tok = await tok
                self._connected = bool(tok)
                return self._connected

            get_user = getattr(self.client, "get_current_user", None) or getattr(
                self.client, "getCurrentUser", None
            )
            if callable(get_user):
                res = get_user()
                if inspect.isawaitable(res):
                    await res
                self._connected = True
                return True
            self._connected = False
            return False
        except Exception:
            self._connected = False
            return False

    async def _run_poll(self) -> dict[str, Any]:
        started_at = self.now()
        self.logger.debug("Starting Plaud polling cycle", {"category": "plaud"})
        discovery_completed = False
        discovery_error: str | None = None
        discovered = 0
        resolved = 0
        error: str | None = None

        try:
            get_user = getattr(self.client, "get_current_user", None) or getattr(
                self.client, "getCurrentUser", None
            )
            if callable(get_user):
                await self._with_plaud_retry(get_user)
            self._connected = True
            discovered = await self._discover()
            discovery_completed = True
            resolution_res = await self._fetch_pending_assets()
            resolved = resolution_res["resolved"]
            error = resolution_res["error"]
            self.logger.debug(
                "Plaud polling cycle finished",
                {
                    "category": "plaud",
                    "discovered": discovered,
                    "resolved": resolved,
                    "durationMs": self.now() - started_at,
                },
            )
        except Exception as poll_err:
            discovery_error = str(poll_err)
            error = discovery_error
            self._connected = False
            self.logger.error("Plaud poll failed", {"error": error})

        completed_at = self.now()
        pcs_pending = await self._pending_count()
        self._last_poll_at = completed_at
        await self._save_poll_state(completed_at, error)

        return {
            "discoveryCompleted": discovery_completed,
            "discoveryError": discovery_error,
            "discovered": discovered,
            "resolved": resolved,
            "pcsPending": pcs_pending,
            "startedAt": started_at,
            "completedAt": completed_at,
            "error": error,
        }

    async def _discover(self) -> int:
        discovered = 0
        seen: set[str] = set()

        async for file in self._iterate_plaud_files():
            file_id = str(file["id"])
            if file_id in seen:
                continue
            seen.add(file_id)

            # Plaud migrated IDs from bare hex to an `of_` prefix; match on the
            # canonical identity so an already-ingested recording is not re-imported.
            canonical_id = canonical_plaud_file_id(file_id)

            with self.db.connect() as conn:
                existing_rec = conn.execute(
                    text(
                        "SELECT id FROM recordings "
                        "WHERE provider = :prov AND provider_recording_id IN (:fid, :canon) LIMIT 1"
                    ),
                    {"prov": PLAUD_PROVIDER, "fid": file_id, "canon": canonical_id},
                ).first()
                existing_state = conn.execute(
                    text(
                        "SELECT meeting_id FROM plaud_ingest_state "
                        "WHERE plaud_file_id IN (:fid, :canon) LIMIT 1"
                    ),
                    {"fid": file_id, "canon": canonical_id},
                ).first()

            if existing_rec or existing_state:
                continue

            seen_at = self.now()
            start_time = _parse_timestamp(file.get("start_at") or file.get("created_at"), seen_at)
            dur_ms = duration_to_ms(file.get("duration"))
            meeting_id = str(uuid.uuid4())
            title = (file.get("name") or "").strip() or f"Plaud recording {file_id}"

            with self.db.begin() as conn:
                already = conn.execute(
                    text(
                        "SELECT meeting_id FROM plaud_ingest_state "
                        "WHERE plaud_file_id IN (:fid, :canon) LIMIT 1"
                    ),
                    {"fid": file_id, "canon": canonical_id},
                ).first()
                if already:
                    continue
                conn.execute(
                    text(
                        """
                        INSERT INTO meetings (
                          id, title, start_time, end_time, source, status, tags,
                          primary_transcript_artifact_id, primary_summary_artifact_id,
                          last_error, created_at, updated_at
                        ) VALUES (
                          :id, :title, :start, :end, 'plaud', 'processing', '[]',
                          NULL, NULL, NULL, :seen, :seen
                        )
                        """
                    ),
                    {
                        "id": meeting_id,
                        "title": title,
                        "start": start_time,
                        "end": start_time + dur_ms,
                        "seen": seen_at,
                    },
                )
                conn.execute(
                    text(
                        """
                        INSERT INTO plaud_ingest_state (
                          meeting_id, plaud_file_id, first_seen_at, pcs_deadline_at, pcs_resolved
                        ) VALUES (
                          :mid, :fid, :seen, :deadline, 0
                        )
                        """
                    ),
                    {
                        "mid": meeting_id,
                        "fid": file_id,
                        "seen": seen_at,
                        "deadline": seen_at + self.pcs_wait_ms,
                    },
                )
                discovered += 1

        return discovered

    async def _iterate_plaud_files(self) -> AsyncIterator[dict[str, Any]]:
        policy = resolve_retry_policy(self.retry_options)
        sleep_fn = self.retry_options.get("sleep")
        attempt = 0

        while True:
            try:
                iter_fn = getattr(self.client, "list_files_iterator", None) or getattr(
                    self.client, "listFilesIterator", None
                )
                if not callable(iter_fn):
                    return
                it: Any = iter_fn({"pageSize": self.page_size})
                async for item in it:
                    yield item
                return
            except Exception as error:
                if attempt >= int(policy["maxRetries"]) or not is_rate_limit_error(error):
                    raise
                delay_ms = compute_retry_delay_ms(error, attempt, policy)
                attempt += 1
                self._log_retry(
                    {
                        "attempt": attempt,
                        "maxRetries": policy["maxRetries"],
                        "delayMs": delay_ms,
                        "error": error,
                    }
                )
                if callable(sleep_fn):
                    sr = sleep_fn(delay_ms)
                    if inspect.isawaitable(sr):
                        await sr
                else:
                    await asyncio.sleep(max(0.0, delay_ms / 1000.0))

    async def _fetch_pending_assets(self) -> dict[str, Any]:
        with self.db.connect() as conn:
            states = (
                conn.execute(text("SELECT * FROM plaud_ingest_state WHERE pcs_resolved = 0")).mappings().all()
            )

        resolved = 0
        errors: list[str] = []

        for state in states:
            if state.get("duplicate_of_meeting_id"):
                continue

            with self.db.connect() as conn:
                meeting = (
                    conn.execute(
                        text("SELECT * FROM meetings WHERE id = :id"),
                        {"id": state["meeting_id"]},
                    )
                    .mappings()
                    .first()
                )
            if not meeting:
                continue

            try:
                get_file_fn = getattr(self.client, "get_file", None) or getattr(self.client, "getFile", None)
                if not callable(get_file_fn):
                    continue
                try:
                    detail, effective_file_id = await self._fetch_plaud_detail(
                        get_file_fn, state["plaud_file_id"]
                    )
                except NotFoundError as missing:
                    await self._mark_file_missing(meeting, state, missing)
                    continue
                state = {**state, "plaud_file_id": effective_file_id}
                has_content = _content_is_ready(detail)
                deadline_expired = (
                    self.now() >= int(state["pcs_deadline_at"])
                    or (self.now() - int(state["first_seen_at"])) >= self.pcs_wait_ms
                )
                if has_content:
                    await self._ingest_ready_meeting(meeting, state, detail)
                    resolved += 1
                elif deadline_expired:
                    await self._ingest_audio_only_meeting(meeting, state, detail)
                    resolved += 1
            except DuplicateAudioError as dup_err:
                await self._mark_duplicate(meeting, state, dup_err.duplicate_of_meeting_id)
                resolved += 1
            except Exception as exc:
                msg = str(exc)
                errors.append(f"{state['plaud_file_id']}: {msg}")
                with self.db.begin() as conn:
                    conn.execute(
                        text(
                            "UPDATE meetings SET last_error = :err, status = 'error', updated_at = :now "
                            "WHERE id = :id"
                        ),
                        {"err": msg, "now": self.now(), "id": meeting["id"]},
                    )
                self.logger.error(
                    "Plaud asset fetch failed",
                    {
                        "error": msg,
                        "meetingId": meeting["id"],
                        "plaudFileId": state["plaud_file_id"],
                    },
                )

        return {"resolved": resolved, "error": "; ".join(errors) if errors else None}

    async def _fetch_plaud_detail(
        self,
        get_file_fn: Callable[[str], Any],
        file_id: str,
    ) -> tuple[Mapping[Any, Any], str]:
        """Fetch a Plaud file, falling back to the other ID form on 404.

        Plaud migrated recording IDs from bare hex to an ``of_`` prefix. Rows
        created before the migration still hold the legacy form (which the API
        now reports as ``FILE_NOT_FOUND``), so retry once with the alternate
        form before treating the recording as permanently missing.
        """
        try:
            detail = await self._with_plaud_retry(lambda fid=file_id: get_file_fn(fid))
            return detail, file_id
        except NotFoundError:
            alternate = alternate_plaud_file_id(file_id)
            if not alternate:
                raise
            detail = await self._with_plaud_retry(lambda alt=alternate: get_file_fn(alt))
            return detail, alternate

    async def _mark_file_missing(
        self,
        meeting: Mapping[Any, Any],
        state: Mapping[Any, Any],
        error: Exception,
    ) -> None:
        """Stop retrying a recording Plaud no longer serves under any ID form."""
        msg = f"Plaud recording is no longer available: {error}"
        resolved_at = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text("UPDATE plaud_ingest_state SET pcs_resolved = 1 WHERE meeting_id = :mid"),
                {"mid": meeting["id"]},
            )
            conn.execute(
                text(
                    "UPDATE meetings SET status = 'error', last_error = :err, updated_at = :now "
                    "WHERE id = :id"
                ),
                {"err": msg, "now": resolved_at, "id": meeting["id"]},
            )
        self.logger.warn(
            "Plaud recording is permanently unavailable; stopping retries",
            {
                "category": "plaud",
                "meetingId": meeting["id"],
                "plaudFileId": state["plaud_file_id"],
                "error": str(error),
            },
        )

    def _hand_off_transcription(self, meeting_id: str, context: str) -> None:
        """Queue automatic transcription without blocking the poll cycle."""
        if not self.transcription_service:
            return
        # Durable work must go through the DBOS job queue (see AGENTS.md):
        # prefer the queue-enqueueing start_transcription entry point. The
        # spawned coroutine below is only scheduling glue that awaits the
        # enqueue — the transcription itself runs as a durable queue job.
        # transcribe_meeting is kept as a fallback for duck-typed doubles.
        fn = (
            getattr(self.transcription_service, "start_transcription", None)
            or getattr(self.transcription_service, "startTranscription", None)
            or getattr(self.transcription_service, "transcribe_meeting", None)
            or getattr(self.transcription_service, "transcribeMeeting", None)
        )
        if not callable(fn):
            return

        async def _run() -> None:
            try:
                res = fn(meeting_id)
                if inspect.isawaitable(res):
                    await res
            except Exception as exc:
                self.logger.warn(
                    f"Automatic transcription failed for {context}",
                    {"meetingId": meeting_id, "error": str(exc)},
                )

        self._spawn_background(_run())

    async def _ingest_ready_meeting(
        self,
        meeting: Mapping[Any, Any],
        state: Mapping[Any, Any],
        detail: Mapping[Any, Any],
    ) -> None:
        recording = await self._ensure_recording(meeting, state, detail)
        segments = parse_transcript_segments(detail.get("source_list"))
        notes = extract_summary_notes(detail.get("note_list"))
        paths = ensure_meeting_folder(
            meeting_paths(self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"])
        )

        transcript_json_id: str | None = None
        if segments:
            t_json = f"{json.dumps(segments, indent=2)}\n"
            t_text = f"{segments_to_text(segments)}\n"
            transcript_json_id = await self._ensure_artifact(
                meeting["id"],
                recording["id"],
                "transcript",
                "json",
                "transcripts/plaud.json",
                t_json,
                paths.transcripts_dir,
            )
            await self._ensure_artifact(
                meeting["id"],
                recording["id"],
                "transcript",
                "txt",
                "transcripts/plaud.txt",
                t_text,
                paths.transcripts_dir,
            )
            await self._persist_named_speakers(meeting["id"], transcript_json_id, segments)

        summary_art_id: str | None = None
        if notes:
            summary_md = summary_to_markdown(notes)
            summary_art_id = await self._ensure_artifact(
                meeting["id"],
                recording["id"],
                "summary",
                "md",
                "summaries/plaud.md",
                summary_md,
                paths.summaries_dir,
            )

        resolved_at = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE meetings
                    SET primary_transcript_artifact_id = :tid,
                        primary_summary_artifact_id = :sid,
                        status = 'ready',
                        last_error = NULL,
                        updated_at = :now
                    WHERE id = :id
                    """
                ),
                {
                    "tid": transcript_json_id,
                    "sid": summary_art_id,
                    "now": resolved_at,
                    "id": meeting["id"],
                },
            )
            conn.execute(
                text("UPDATE plaud_ingest_state SET pcs_resolved = 1 WHERE meeting_id = :id"),
                {"id": meeting["id"]},
            )

        has_only_generic = not segments or all(is_generic_plaud_speaker(s.get("speaker")) for s in segments)
        if self.auto_transcribe_with_speechmatics or (
            self.retranscribe_plaud_when_unnamed and has_only_generic
        ):
            self._hand_off_transcription(meeting["id"], "Plaud meeting")

    async def _ingest_audio_only_meeting(
        self,
        meeting: Mapping[Any, Any],
        state: Mapping[Any, Any],
        detail: Mapping[Any, Any],
    ) -> None:
        await self._ensure_recording(meeting, state, detail)
        resolved_at = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text(
                    "UPDATE meetings SET status = 'ready', last_error = NULL, updated_at = :now "
                    "WHERE id = :id"
                ),
                {"now": resolved_at, "id": meeting["id"]},
            )
            conn.execute(
                text("UPDATE plaud_ingest_state SET pcs_resolved = 1 WHERE meeting_id = :id"),
                {"id": meeting["id"]},
            )

        self._hand_off_transcription(meeting["id"], "audio-only Plaud meeting")

    async def _ensure_recording(
        self,
        meeting: Mapping[Any, Any],
        state: Mapping[Any, Any],
        detail: Mapping[Any, Any],
    ) -> dict[str, str]:
        with self.db.connect() as conn:
            existing = (
                conn.execute(
                    text(
                        "SELECT id, path FROM recordings "
                        "WHERE provider = :prov AND provider_recording_id = :fid LIMIT 1"
                    ),
                    {"prov": PLAUD_PROVIDER, "fid": state["plaud_file_id"]},
                )
                .mappings()
                .first()
            )

        if existing:
            existing_abs = (
                Path(
                    meeting_paths(
                        self.meetings_dir,
                        int(meeting["start_time"]),
                        meeting["title"],
                        meeting["id"],
                    ).folder
                )
                / existing["path"]
            )
            if existing_abs.exists():
                return {"id": existing["id"], "path": existing["path"]}

        downloaded = await self._download_audio(detail)

        with self.db.connect() as conn:
            existing_by_hash = (
                conn.execute(
                    text("SELECT id, meeting_id, path FROM recordings WHERE sha256 = :sha LIMIT 1"),
                    {"sha": downloaded["sha256"]},
                )
                .mappings()
                .first()
            )

        if existing_by_hash:
            if existing_by_hash["meeting_id"] != meeting["id"]:
                raise DuplicateAudioError(existing_by_hash["meeting_id"])

            if not existing:
                with self.db.begin() as conn:
                    conn.execute(
                        text("UPDATE recordings SET provider_recording_id = :fid WHERE id = :id"),
                        {"fid": state["plaud_file_id"], "id": existing_by_hash["id"]},
                    )
            m_folder = Path(
                meeting_paths(
                    self.meetings_dir,
                    int(meeting["start_time"]),
                    meeting["title"],
                    meeting["id"],
                ).folder
            )
            abs_path = m_folder / existing_by_hash["path"]
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            if not abs_path.exists():
                abs_path.write_bytes(downloaded["bytes"])
            return {"id": existing_by_hash["id"], "path": existing_by_hash["path"]}

        rec_id = existing["id"] if existing else str(uuid.uuid4())
        rel_path = f"audio/{rec_id}.{downloaded['extension']}"
        paths = ensure_meeting_folder(
            meeting_paths(self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"])
        )
        (Path(paths.folder) / rel_path).write_bytes(downloaded["bytes"])
        dur_ms = duration_to_ms(detail.get("duration")) or (
            int(meeting["end_time"]) - int(meeting["start_time"])
        )

        with self.db.begin() as conn:
            if existing:
                conn.execute(
                    text(
                        """
                        UPDATE recordings
                        SET path = :path, mime = :mime, duration_ms = :dur,
                            size_bytes = :sz, sha256 = :sha
                        WHERE id = :id
                        """
                    ),
                    {
                        "path": rel_path,
                        "mime": downloaded["mime"],
                        "dur": dur_ms,
                        "sz": len(downloaded["bytes"]),
                        "sha": downloaded["sha256"],
                        "id": existing["id"],
                    },
                )
                return {"id": existing["id"], "path": rel_path}

            conn.execute(
                text(
                    """
                    INSERT INTO recordings (
                      id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                      provider, provider_recording_id, created_at
                    ) VALUES (
                      :id, :mid, :path, :mime, :dur, :sz, :sha,
                      'plaud', :fid, :now
                    )
                    """
                ),
                {
                    "id": rec_id,
                    "mid": meeting["id"],
                    "path": rel_path,
                    "mime": downloaded["mime"],
                    "dur": dur_ms,
                    "sz": len(downloaded["bytes"]),
                    "sha": downloaded["sha256"],
                    "fid": state["plaud_file_id"],
                    "now": self.now(),
                },
            )

        return {"id": rec_id, "path": rel_path}

    async def _mark_duplicate(
        self,
        meeting: Mapping[Any, Any],
        state: Mapping[Any, Any],
        duplicate_of_meeting_id: str,
    ) -> None:
        resolved_at = self.now()
        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    UPDATE plaud_ingest_state
                    SET pcs_resolved = 1, duplicate_of_meeting_id = :dup_id
                    WHERE meeting_id = :mid
                    """
                ),
                {"dup_id": duplicate_of_meeting_id, "mid": meeting["id"]},
            )
            conn.execute(
                text(
                    """
                    UPDATE meetings
                    SET status = 'duplicate',
                        last_error = :err,
                        updated_at = :now
                    WHERE id = :mid
                    """
                ),
                {
                    "err": f"Duplicate of meeting {duplicate_of_meeting_id}: audio already ingested under another meeting",
                    "now": resolved_at,
                    "mid": meeting["id"],
                },
            )
        self.logger.warn(
            "Skipping duplicate Plaud recording; audio already ingested under another meeting",
            {
                "category": "plaud",
                "meetingId": meeting["id"],
                "plaudFileId": state["plaud_file_id"],
                "duplicateOfMeetingId": duplicate_of_meeting_id,
            },
        )

    async def _download_audio(self, detail: Mapping[str, Any]) -> dict[str, Any]:
        presigned_url = detail.get("presigned_url")
        if not presigned_url:
            raise ValueError("Plaud recording has no presigned audio URL")

        async def _do_fetch() -> Any:
            res = self.fetch_impl(str(presigned_url))
            if inspect.isawaitable(res):
                res = await res
            status = getattr(res, "status", None) or getattr(res, "status_code", 200)
            if status == 429:
                raise rate_limit_error_from_response(res)
            return res

        response = await self._with_plaud_retry(_do_fetch)
        status = getattr(response, "status", None) or getattr(response, "status_code", 200)
        ok = getattr(response, "ok", 200 <= int(status) < 300)
        if not ok:
            raise RuntimeError(f"Audio download failed with HTTP {status}")

        raw_bytes: bytes = b""
        if hasattr(response, "arrayBuffer") and callable(response.arrayBuffer):
            ab: Any = response.arrayBuffer()
            ab_val: Any = await ab if inspect.isawaitable(ab) else ab
            raw_bytes = bytes(ab_val)
        elif hasattr(response, "read") and callable(response.read):
            r: Any = response.read()
            r_val: Any = await r if inspect.isawaitable(r) else r
            raw_bytes = bytes(r_val)
        elif hasattr(response, "content"):
            raw_bytes = bytes(response.content)

        audio_bytes = raw_bytes
        # Plaud serves some recordings as headerless raw Opus packets that
        # nothing can decode; store them wrapped in an Ogg Opus container.
        if is_raw_plaud_opus(audio_bytes):
            audio_bytes = wrap_raw_opus_bytes(audio_bytes)
        sha256 = hashlib.sha256(audio_bytes).hexdigest()
        headers = getattr(response, "headers", None) or {}
        resp_mime = (headers.get("content-type") if hasattr(headers, "get") else "") or ""
        extension = (
            _extension_from_url(str(presigned_url))
            or _extension_from_mime(resp_mime)
            or DEFAULT_AUDIO_EXTENSION
        )
        mime = (
            resp_mime.split(";", 1)[0]
            if resp_mime.lower().startswith("audio/")
            else _mime_for_extension(extension)
        )
        return {
            "bytes": audio_bytes,
            "extension": extension,
            "mime": mime,
            "sha256": sha256,
        }

    async def _ensure_artifact(
        self,
        meeting_id: str,
        recording_id: str,
        kind: str,
        fmt: str,
        relative_path: str,
        content: str,
        directory: str,
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
                        "prov": PLAUD_PROVIDER,
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
                    "prov": PLAUD_PROVIDER,
                    "fmt": fmt,
                    "path": relative_path,
                    "now": self.now(),
                },
            )
            return art_id

    async def _persist_named_speakers(
        self,
        meeting_id: str,
        evidence_artifact_id: str,
        segments: list[dict[str, Any]],
    ) -> None:
        names = {
            _normalize_speaker_name(str(s["speaker"]))
            for s in segments
            if s.get("speaker") and not is_generic_plaud_speaker(str(s["speaker"]))
        }
        with self.db.begin() as conn:
            for name in names:
                all_speakers = conn.execute(text("SELECT * FROM speakers")).mappings().all()
                norm = name.lower()
                existing = next(
                    (s for s in all_speakers if s["name"].strip().lower() == norm),
                    None,
                )
                speaker_id = existing["id"] if existing else str(uuid.uuid4())
                if not existing:
                    conn.execute(
                        text(
                            """
                            INSERT INTO speakers (
                              id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                            ) VALUES (:id, :name, '{}', NULL, '[]', :now)
                            """
                        ),
                        {"id": speaker_id, "name": name, "now": self.now()},
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

    async def _pending_count(self) -> int:
        with self.db.connect() as conn:
            cnt = conn.execute(
                text("SELECT COUNT(meeting_id) FROM plaud_ingest_state WHERE pcs_resolved = 0")
            ).scalar()
        return int(cnt or 0)

    async def _save_poll_state(self, completed_at: int, error: str | None) -> None:
        with self.db.begin() as conn:
            for k, v in [
                ("plaud:last_poll_at", str(completed_at)),
                ("plaud:last_poll_error", error or ""),
            ]:
                conn.execute(
                    text(
                        """
                        INSERT INTO sync_state (key, value)
                        VALUES (:k, :v)
                        ON CONFLICT(key) DO UPDATE SET value = :v
                        """
                    ),
                    {"k": k, "v": v},
                )
