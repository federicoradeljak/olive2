"""Speechmatics batch API client wrapper (port of providers/speechmatics/client.ts)."""

from __future__ import annotations

import asyncio
import inspect
import io
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any

from speechmatics.batch import (
    AsyncClient,
    FetchData,
    FormatType,
    JobConfig,
    JobType,
    Model,
    NotificationConfig,
    NotificationContents,
    Transcript,
    TranscriptionConfig,
)

_FORMAT_BY_ARG: dict[str, FormatType] = {
    "json-v2": FormatType.JSON,
    "text": FormatType.TXT,
    "srt": FormatType.SRT,
}


def _to_job_config(job_config: dict[str, Any], fetch_data: FetchData | None) -> JobConfig:
    tc = job_config.get("transcription_config") or {}
    notifications = [
        NotificationConfig(
            url=n["url"],
            contents=[NotificationContents(c) for c in n.get("contents") or []],
            auth_headers=n.get("auth_headers"),
        )
        for n in job_config.get("notification_config") or []
    ]
    return JobConfig(
        type=JobType.TRANSCRIPTION,
        fetch_data=fetch_data,
        transcription_config=TranscriptionConfig(
            # Pin standard explicitly: the SDK otherwise defaults to the
            # pricier enhanced model, unlike the pre-SDK raw API behaviour.
            model=Model.STANDARD,
            language=tc.get("language", "en"),
            diarization=tc.get("diarization"),
            additional_vocab=tc.get("additional_vocab"),
            speaker_diarization_config=tc.get("speaker_diarization_config"),
        ),
        notification_config=notifications or None,
    )


def _additional_vocab(raw: Any) -> list[dict[str, Any]]:
    """Plain strings become ``{"content": s}``; dicts (with ``sounds_like``) pass through."""
    entries: list[dict[str, Any]] = []
    for item in raw or []:
        if isinstance(item, dict):
            if str(item.get("content") or "").strip():
                entries.append(item)
        elif str(item).strip():
            entries.append({"content": str(item).strip()})
    return entries


class _SdkBatchClient:
    """Adapts speechmatics.batch.AsyncClient to the internal camelCase batch interface."""

    def __init__(self, api_key: str, api_url: str | None = None) -> None:
        self.api_key = api_key
        self.api_url = api_url

    def _client(self) -> AsyncClient:
        return AsyncClient(api_key=self.api_key, url=self.api_url)

    async def createTranscriptionJob(self, input_data: dict[str, Any], job_config: dict[str, Any]) -> Any:
        if "url" in input_data:
            config = _to_job_config(job_config, FetchData(url=input_data["url"]))
            async with self._client() as client:
                return await client.submit_job(None, config=config)

        config = _to_job_config(job_config, None)
        data_file = io.BytesIO(bytes(input_data.get("data") or b""))
        data_file.name = str(input_data.get("fileName") or "audio.m4a")
        async with self._client() as client:
            return await client.submit_job(data_file, config=config)

    async def getJob(self, job_id: str) -> dict[str, Any]:
        async with self._client() as client:
            details = await client.get_job_info(job_id)
        return {
            "job": {
                "id": details.id,
                "status": details.status.value,
                "created_at": details.created_at,
                "data_name": details.data_name,
                "duration": details.duration,
                "errors": [{"timestamp": e.timestamp, "message": e.message} for e in details.errors]
                if details.errors
                else None,
            }
        }

    async def getJobResult(self, job_id: str, fmt: str = "json-v2") -> Any:
        format_type = _FORMAT_BY_ARG[fmt]
        async with self._client() as client:
            result = await client.get_transcript(job_id, format_type=format_type)
        if isinstance(result, Transcript):
            return asdict(result)
        return result

    async def deleteJob(self, job_id: str) -> None:
        async with self._client() as client:
            await client.delete_job(job_id)


class SpeechmaticsClient:
    DEFAULT_SUBMIT_TIMEOUT_MS = 30_000

    def __init__(self, options: dict[str, Any] | None = None, **kwargs: Any) -> None:
        opts = {**(options or {}), **kwargs}
        if "apiKey" in opts or "api_key" in opts:
            raw_key = opts.get("apiKey") if "apiKey" in opts else opts.get("api_key")
            self.api_key = str(raw_key if raw_key is not None else "")
        else:
            self.api_key = os.environ.get("SPEECHMATICS_API_KEY") or ""

        self.api_url: str | None = opts.get("apiUrl") or opts.get("api_url")
        self.app_id: str = str(opts.get("appId") or opts.get("app_id") or "olive-meeting-pipeline")
        st_opt = opts.get("submitTimeoutMs")
        if st_opt is None:
            st_opt = opts.get("submit_timeout_ms")
        self.submit_timeout_ms: int = int(st_opt if st_opt is not None else self.DEFAULT_SUBMIT_TIMEOUT_MS)
        self._client = (
            opts.get("batchClient") or opts.get("batch_client") or _SdkBatchClient(self.api_key, self.api_url)
        )

    def set_api_key(self, api_key: str | None) -> None:
        """Updates the key at runtime (e.g. after a Settings-UI save)."""
        self.api_key = str(api_key or "")
        inner = getattr(self, "_client", None)
        if inner is not None and hasattr(inner, "api_key"):
            try:
                inner.api_key = self.api_key
            except Exception:
                pass

    setApiKey = set_api_key

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key.strip())

    @property
    def isConfigured(self) -> bool:
        return self.is_configured

    @property
    def raw_client(self) -> Any:
        return self._client

    @property
    def rawClient(self) -> Any:
        return self._client

    async def submit_job(self, options: dict[str, Any]) -> dict[str, Any]:
        if not self.is_configured:
            raise RuntimeError("Speechmatics API key is not configured")

        language = str(options.get("language") or "en")
        speaker_diarization_config: dict[str, Any] = {}

        speakers = options.get("speakers")
        if speakers and isinstance(speakers, list):
            speaker_diarization_config["speakers"] = [
                {
                    "label": s["label"],
                    "speaker_identifiers": list(s.get("speaker_identifiers") or []),
                }
                for s in speakers[:50]
                if isinstance(s, dict) and s.get("label")
            ]

        if options.get("getSpeakers") or options.get("get_speakers"):
            speaker_diarization_config["get_speakers"] = True

        transcription_config: dict[str, Any] = {
            "language": language,
            "diarization": "speaker",
        }
        if speaker_diarization_config:
            transcription_config["speaker_diarization_config"] = speaker_diarization_config

        additional_vocab = _additional_vocab(
            options.get("additionalVocab") or options.get("additional_vocab")
        )
        if additional_vocab:
            transcription_config["additional_vocab"] = additional_vocab

        job_config: dict[str, Any] = {"transcription_config": transcription_config}

        webhook_url = options.get("webhookUrl") or options.get("webhook_url")
        webhook_secret = options.get("webhookSecret") or options.get("webhook_secret")
        if webhook_url:
            auth_headers: list[str] = []
            if webhook_secret:
                auth_headers.append(f"Authorization: Bearer {webhook_secret}")
            notif: dict[str, Any] = {
                "url": webhook_url,
                "contents": ["transcript"],
            }
            if auth_headers:
                notif["auth_headers"] = auth_headers
            job_config["notification_config"] = [notif]

        audio = options.get("audio")
        if audio is None:
            raise ValueError("No audio provided for transcription job")

        filename = str(options.get("filename") or "audio.m4a")
        mime = str(options.get("mime") or "audio/mp4")

        if isinstance(audio, dict) and "url" in audio:
            input_payload: dict[str, Any] = {"url": audio["url"]}
        elif isinstance(audio, dict) and "path" in audio:
            data_bytes = Path(audio["path"]).read_bytes()
            input_payload = {"data": data_bytes, "fileName": filename, "mime": mime}
        elif isinstance(audio, (bytes, bytearray, memoryview)):
            input_payload = {"data": bytes(audio), "fileName": filename, "mime": mime}
        else:
            input_payload = {"data": audio, "fileName": filename, "mime": mime}

        create_fn = getattr(self._client, "createTranscriptionJob", None) or getattr(
            self._client, "create_transcription_job", None
        )
        if not callable(create_fn):
            raise AttributeError("batchClient missing createTranscriptionJob")

        try:
            coro = create_fn(input_payload, job_config)
            if inspect.isawaitable(coro):
                response = await asyncio.wait_for(coro, timeout=self.submit_timeout_ms / 1000.0)
            else:
                response = coro
        except TimeoutError as exc:
            raise RuntimeError(f"Speechmatics upload timed out after {self.submit_timeout_ms}ms") from exc

        job_id = response["id"] if isinstance(response, dict) else getattr(response, "id", "")
        return {"id": job_id}

    submitJob = submit_job

    async def get_job(self, job_id: str) -> dict[str, Any]:
        fn = getattr(self._client, "getJob", None) or getattr(self._client, "get_job", None)
        if not callable(fn):
            raise AttributeError("batchClient missing getJob")
        res = fn(job_id)
        if inspect.isawaitable(res):
            res = await res
        job = res["job"] if isinstance(res, dict) and "job" in res else getattr(res, "job", res)
        if isinstance(job, dict):
            raw_errors = job.get("errors")
            errors = (
                [
                    {"code": "JOB_ERROR", "message": e.get("message", "") if isinstance(e, dict) else str(e)}
                    for e in raw_errors
                ]
                if raw_errors
                else None
            )
            out: dict[str, Any] = {
                "id": job["id"],
                "status": job["status"],
                "created_at": job.get("created_at", ""),
                "data_name": job.get("data_name"),
                "duration": job.get("duration"),
                "errors": errors,
            }
            return out
        return {
            "id": getattr(job, "id", job_id),
            "status": getattr(job, "status", "running"),
            "created_at": getattr(job, "created_at", ""),
            "data_name": getattr(job, "data_name", None),
            "duration": getattr(job, "duration", None),
            "errors": None,
        }

    getJob = get_job

    async def get_transcript(self, job_id: str, fmt: str = "json-v2") -> Any:
        fn = getattr(self._client, "getJobResult", None) or getattr(self._client, "get_job_result", None)
        if not callable(fn):
            raise AttributeError("batchClient missing getJobResult")
        arg_fmt = "json-v2" if fmt == "json-v2" else ("text" if fmt == "txt" else "srt")
        res = fn(job_id, arg_fmt)
        if inspect.isawaitable(res):
            res = await res
        return res

    getTranscript = get_transcript

    async def delete_job(self, job_id: str) -> Any:
        fn = getattr(self._client, "deleteJob", None) or getattr(self._client, "delete_job", None)
        if not callable(fn):
            raise AttributeError("batchClient missing deleteJob")
        res = fn(job_id)
        if inspect.isawaitable(res):
            res = await res
        return res

    deleteJob = delete_job
