"""Muse Voice Transcribe file transcription client.

There is no official Meta Python SDK for the voice endpoints (Meta's SDK
story is the OpenAI/Anthropic SDKs for text models; voice docs use raw
``requests``/``websockets``), so this is a thin ``httpx`` client over the
documented ``POST /v1/asr/transcribe`` multipart API.

Injection seam: pass ``sender=`` with an async callable
``(url, headers, request_json, audio_bytes, filename, session_id, timeout_s) ->
dict``. It replaces the httpx call and is used for tests.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any

from .types import MuseTranscribeResponse

DEFAULT_BASE_URL = "https://api.meta.ai/v1"
DEFAULT_MODEL = "muse-voice-transcribe-1.0"
DIARIZATION_MODE = "DIARIZATION"

# ISO-ish code -> Muse language name (25 supported languages, code-switching).
LANGUAGE_NAME_BY_CODE: dict[str, str] = {
    "ar": "Arabic",
    "bn": "Bengali",
    "nl": "Dutch",
    "en": "English",
    "fr": "French",
    "de": "German",
    "he": "Hebrew",
    "hi": "Hindi",
    "id": "Indonesian",
    "it": "Italian",
    "ja": "Japanese",
    "kn": "Kannada",
    "ko": "Korean",
    "ms": "Malay",
    "zh": "Mandarin Chinese",
    "mr": "Marathi",
    "pl": "Polish",
    "pt": "Portuguese",
    "es": "Spanish",
    "tl": "Tagalog",
    "ta": "Tamil",
    "te": "Telugu",
    "th": "Thai",
    "tr": "Turkish",
    "vi": "Vietnamese",
}
_LANGUAGE_NAMES = {v.lower(): v for v in LANGUAGE_NAME_BY_CODE.values()}


def _keyterms(raw: Any) -> list[str]:
    terms: list[str] = []
    for item in raw or []:
        content = item.get("content") if isinstance(item, dict) else item
        if content and str(content).strip():
            terms.append(str(content).strip())
    return terms


def _language_bias(raw: Any) -> list[str] | None:
    """Maps Olive ``language`` opts to Muse ``languageBias`` names.

    Accepts ISO codes (``en``/``en-US``), full names (``English``), or a list
    of either. Unknown values are dropped; ``None`` means auto-detect.
    """
    items = raw if isinstance(raw, list) else [raw]
    biased: list[str] = []
    for item in items:
        if not item or not str(item).strip():
            continue
        token = str(item).strip()
        lowered = token.lower()
        if lowered in _LANGUAGE_NAMES:
            name = _LANGUAGE_NAMES[lowered]
        else:
            code = lowered.replace("_", "-").split("-")[0]
            name = LANGUAGE_NAME_BY_CODE.get(code, "")
        if name and name not in biased:
            biased.append(name)
    return biased or None


def _build_request(options: dict[str, Any], model: str) -> dict[str, Any]:
    mode = str(options.get("mode") or DIARIZATION_MODE).strip().upper()
    if mode not in ("PUSH_TO_TALK", "ENDPOINTING", "DIARIZATION"):
        mode = DIARIZATION_MODE
    request: dict[str, Any] = {
        "model": model,
        "audioEncoding": "WAV",
        "mode": mode,
    }
    keyterms = _keyterms(
        options.get("keywords")
        or options.get("keyterms")
        or options.get("additionalVocab")
        or options.get("additional_vocab")
    )
    if keyterms:
        request["keywords"] = keyterms
    bias = _language_bias(
        options.get("languageBias") or options.get("language_bias") or options.get("language")
    )
    if bias:
        request["languageBias"] = bias
    return request


async def _default_sender(
    url: str,
    headers: dict[str, str],
    request_json: dict[str, Any],
    audio_bytes: bytes,
    filename: str,
    session_id: str,
    timeout_s: float,
) -> dict[str, Any]:
    import json as _json

    import httpx

    files = {
        "request": (None, _json.dumps(request_json), "application/json"),
        "audio": (filename, audio_bytes, "audio/wav"),
    }
    async with httpx.AsyncClient(timeout=timeout_s) as client:
        response = await client.post(url, headers=headers, files=files)
    try:
        payload = response.json()
    except Exception:
        payload = {}
    if response.status_code == 200 and isinstance(payload, dict):
        return payload
    message = ""
    if isinstance(payload, dict):
        message = str(payload.get("message") or payload.get("error") or "")
    raise RuntimeError(
        f"Muse transcription failed (HTTP {response.status_code}): {message or response.text[:300]}"
    )


class MuseClient:
    def __init__(self, options: dict[str, Any] | None = None, **kwargs: Any) -> None:
        opts = {**(options or {}), **kwargs}
        if "apiKey" in opts or "api_key" in opts:
            raw_key = opts.get("apiKey") if "apiKey" in opts else opts.get("api_key")
            self.api_key = str(raw_key if raw_key is not None else "")
        else:
            self.api_key = os.environ.get("MUSE_API_KEY") or os.environ.get("MODEL_API_KEY") or ""
        self.base_url: str = str(opts.get("baseUrl") or opts.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
        self.model: str = str(opts.get("model") or DEFAULT_MODEL)
        timeout_opt = opts.get("timeoutMs", opts.get("timeout_ms", 300_000))
        self.timeout_s: float = float(timeout_opt) / 1000.0
        self.max_retries: int = int(opts.get("maxRetries", opts.get("max_retries", 3)))
        self._sender: Any = opts.get("sender") or _default_sender

    @property
    def is_configured(self) -> bool:
        return bool(self.api_key.strip())

    @property
    def isConfigured(self) -> bool:
        return self.is_configured

    async def transcribe_wav(
        self, audio_bytes: bytes | bytearray | memoryview, options: dict[str, Any] | None = None
    ) -> MuseTranscribeResponse:
        """Transcribes one WAV clip (mono 16-bit PCM 16/24 kHz, <=10 min / <=32 MB)."""
        if not self.is_configured:
            raise RuntimeError("Muse API key is not configured")
        opts = dict(options or {})
        data = bytes(audio_bytes)
        if not data:
            raise ValueError("No audio provided for Muse transcription")
        request_json = _build_request(opts, self.model)
        session_id = str(opts.get("sessionId") or opts.get("session_id") or f"muse-{uuid.uuid4().hex[:8]}")
        url = f"{self.base_url}/asr/transcribe?sessionId={session_id}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
        }
        filename = str(opts.get("filename") or "chunk.wav")

        attempt = 0
        while True:
            try:
                result = self._sender(url, headers, request_json, data, filename, session_id, self.timeout_s)
                if asyncio.iscoroutine(result):
                    result = await result
                if not isinstance(result, dict):
                    raise RuntimeError("Muse transcription returned an unexpected response")
                return result  # type: ignore[return-value]
            except RuntimeError as exc:
                if "HTTP 429" not in str(exc) or attempt >= self.max_retries:
                    raise
                attempt += 1
                await asyncio.sleep(min(2.0**attempt, 8.0))

    transcribeWav = transcribe_wav
