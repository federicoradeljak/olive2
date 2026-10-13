"""Speechmatics batch API client wrapper (port of providers/speechmatics/client.ts)."""

from __future__ import annotations

import asyncio
import inspect
import os
from pathlib import Path
from typing import Any

import httpx


class _DefaultBatchHttpClient:
    """Thin async HTTP client for Speechmatics v2 batch endpoints."""

    def __init__(self, api_key: str, api_url: str | None = None, app_id: str = "olive-meeting-pipeline") -> None:
        self.api_key = api_key
        base = (api_url or "https://asr.api.speechmatics.com/v2").rstrip("/")
        self.base_url = base
        self.app_id = app_id

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}"}

    async def createTranscriptionJob(self, input_data: dict[str, Any], job_config: dict[str, Any]) -> dict[str, Any]:
        import json

        config_payload = {"type": "transcription", **job_config}
        async with httpx.AsyncClient(timeout=60.0) as client:
            if "url" in input_data:
                config_payload["fetch_data"] = {"url": input_data["url"]}
                res = await client.post(
                    f"{self.base_url}/jobs",
                    headers=self._headers(),
                    files={"config": (None, json.dumps(config_payload), "application/json")},
                )
            else:
                file_bytes = bytes(input_data.get("data") or b"")
                file_name = str(input_data.get("fileName") or "audio.m4a")
                mime = str(input_data.get("mime") or "audio/mp4")
                res = await client.post(
                    f"{self.base_url}/jobs",
                    headers=self._headers(),
                    files={
                        "data_file": (file_name, file_bytes, mime),
                        "config": (None, json.dumps(config_payload), "application/json"),
                    },
                )
            res.raise_for_status()
            return res.json()

    async def getJob(self, job_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.get(f"{self.base_url}/jobs/{job_id}", headers=self._headers())
            res.raise_for_status()
            return res.json()

    async def getJobResult(self, job_id: str, fmt: str = "json-v2") -> Any:
        async with httpx.AsyncClient(timeout=60.0) as client:
            res = await client.get(
                f"{self.base_url}/jobs/{job_id}/transcript",
                params={"format": fmt},
                headers=self._headers(),
            )
            res.raise_for_status()
            if fmt == "json-v2":
                return res.json()
            return res.text

    async def deleteJob(self, job_id: str) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=30.0) as client:
            res = await client.delete(f"{self.base_url}/jobs/{job_id}", headers=self._headers())
            res.raise_for_status()
            return res.json()


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
        self.submit_timeout_ms: int = int(
            st_opt if st_opt is not None else self.DEFAULT_SUBMIT_TIMEOUT_MS
        )
        self._client = (
            opts.get("batchClient")
            or opts.get("batch_client")
            or _DefaultBatchHttpClient(self.api_key, self.api_url, self.app_id)
        )

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

        additional_vocab = options.get("additionalVocab") or options.get("additional_vocab")
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
                response = await asyncio.wait_for(
                    coro, timeout=self.submit_timeout_ms / 1000.0
                )
            else:
                response = coro
        except TimeoutError as exc:
            raise RuntimeError(
                f"Speechmatics upload timed out after {self.submit_timeout_ms}ms"
            ) from exc

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
        fn = getattr(self._client, "getJobResult", None) or getattr(
            self._client, "get_job_result", None
        )
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
