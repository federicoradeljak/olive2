"""Muse client tests using an injected sender (no network)."""

from __future__ import annotations

from typing import Any

import pytest

from olive.providers.muse import MuseClient


def _sender(payload: Any, calls: list[dict[str, Any]] | None = None):
    async def _send(
        url: str,
        headers: dict[str, str],
        request_json: dict[str, Any],
        audio_bytes: bytes,
        filename: str,
        session_id: str,
        timeout_s: float,
    ) -> Any:
        if calls is not None:
            calls.append(
                {
                    "url": url,
                    "headers": headers,
                    "request": request_json,
                    "audio_len": len(audio_bytes),
                    "filename": filename,
                    "session_id": session_id,
                }
            )
        if isinstance(payload, Exception):
            raise payload
        return payload

    return _send


def _response() -> dict[str, Any]:
    return {
        "transcript": "Hello everyone.",
        "audioDurationMs": 5000,
        "turns": [{"text": "Hello everyone.", "speaker": "A", "startMs": 100, "endMs": 1000}],
        "sessionId": "s-1",
    }


async def test_success_posts_multipart_shape() -> None:
    calls: list[dict[str, Any]] = []
    client = MuseClient({"apiKey": "test-key", "sender": _sender(_response(), calls)})
    out = await client.transcribe_wav(
        b"RIFF" + b"\x00" * 100,
        {"mode": "DIARIZATION", "sessionId": "sess-9", "filename": "chunk.wav"},
    )
    assert out["sessionId"] == "s-1"
    assert len(calls) == 1
    call = calls[0]
    assert call["url"] == "https://api.meta.ai/v1/asr/transcribe?sessionId=sess-9"
    assert call["headers"]["Authorization"] == "Bearer test-key"
    assert call["headers"]["Accept"] == "application/json"
    assert call["request"] == {
        "model": "muse-voice-transcribe-1.0",
        "audioEncoding": "WAV",
        "mode": "DIARIZATION",
    }
    assert call["audio_len"] == 104


async def test_keywords_and_language_bias_are_mapped() -> None:
    calls: list[dict[str, Any]] = []
    client = MuseClient({"apiKey": "k", "sender": _sender(_response(), calls)})
    await client.transcribe_wav(
        b"wav-bytes",
        {"additionalVocab": ["Olive", {"content": "Kubernetes"}], "language": "en"},
    )
    request = calls[0]["request"]
    assert request["keywords"] == ["Olive", "Kubernetes"]
    assert request["languageBias"] == ["English"]
    assert request["mode"] == "DIARIZATION"


async def test_language_names_pass_through_and_unknowns_dropped() -> None:
    calls: list[dict[str, Any]] = []
    client = MuseClient({"apiKey": "k", "sender": _sender(_response(), calls)})
    await client.transcribe_wav(b"wav", {"languageBias": ["French", "Klingon"]})
    assert calls[0]["request"]["languageBias"] == ["French"]


async def test_invalid_mode_falls_back_to_diarization() -> None:
    calls: list[dict[str, Any]] = []
    client = MuseClient({"apiKey": "k", "sender": _sender(_response(), calls)})
    await client.transcribe_wav(b"wav", {"mode": "bogus"})
    assert calls[0]["request"]["mode"] == "DIARIZATION"


async def test_429_retries_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio as _asyncio

    async def _no_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(_asyncio, "sleep", _no_sleep)
    attempts = {"n": 0}

    async def _flaky(*args: Any, **kwargs: Any) -> Any:
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise RuntimeError("Muse transcription failed (HTTP 429): concurrency limit")
        return _response()

    client = MuseClient({"apiKey": "k", "sender": _flaky, "maxRetries": 3})
    out = await client.transcribe_wav(b"wav")
    assert out["sessionId"] == "s-1"
    assert attempts["n"] == 3


async def test_429_exhausted_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio as _asyncio

    async def _no_sleep(_s: float) -> None:
        return None

    monkeypatch.setattr(_asyncio, "sleep", _no_sleep)
    client = MuseClient(
        {
            "apiKey": "k",
            "sender": _sender(RuntimeError("Muse transcription failed (HTTP 429): busy")),
            "maxRetries": 1,
        }
    )
    with pytest.raises(RuntimeError, match="HTTP 429"):
        await client.transcribe_wav(b"wav")


async def test_non_retryable_error_raises_without_retry() -> None:
    calls: list[dict[str, Any]] = []
    client = MuseClient(
        {
            "apiKey": "k",
            "sender": _sender(RuntimeError("Muse transcription failed (HTTP 400): bad wav"), calls),
        }
    )
    with pytest.raises(RuntimeError, match="HTTP 400"):
        await client.transcribe_wav(b"wav")
    assert len(calls) == 1


async def test_key_not_configured_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MUSE_API_KEY", raising=False)
    monkeypatch.delenv("MODEL_API_KEY", raising=False)
    client = MuseClient({"sender": _sender(_response())})
    assert client.is_configured is False
    with pytest.raises(RuntimeError, match="Muse API key is not configured"):
        await client.transcribe_wav(b"wav")


async def test_env_keys_are_used(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MUSE_API_KEY", "muse-env-key")
    assert MuseClient({"sender": _sender(_response())}).is_configured is True
    assert MuseClient({"sender": _sender(_response())}).isConfigured is True
    monkeypatch.delenv("MUSE_API_KEY", raising=False)
    monkeypatch.setenv("MODEL_API_KEY", "model-env-key")
    assert MuseClient({"sender": _sender(_response())}).is_configured is True


async def test_empty_audio_raises() -> None:
    client = MuseClient({"apiKey": "k", "sender": _sender(_response())})
    with pytest.raises(ValueError, match="No audio"):
        await client.transcribe_wav(b"")


async def test_camel_case_alias_works() -> None:
    client = MuseClient({"apiKey": "k", "sender": _sender(_response())})
    out = await client.transcribeWav(b"wav")
    assert out["sessionId"] == "s-1"
