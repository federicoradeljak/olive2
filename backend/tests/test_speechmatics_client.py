"""Speechmatics client tests (port of speechmatics-client.test.ts)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from olive.providers.speechmatics import SpeechmaticsClient


class _MockBatchClient:
    def __init__(self, **handlers: Any) -> None:
        self.__dict__.update(handlers)


async def test_rejects_immediately_when_no_api_key_is_configured() -> None:
    client = SpeechmaticsClient(
        {
            "apiKey": "",
            "batchClient": _MockBatchClient(
                createTranscriptionJob=lambda *_: {"id": "unexpected"}
            ),
        }
    )
    with pytest.raises(RuntimeError, match="Speechmatics API key is not configured"):
        await client.submit_job({"audio": bytes([1, 2, 3]), "filename": "test.m4a"})


async def test_fails_stuck_upload_instead_of_waiting_indefinitely() -> None:
    async def never_finish(*_args: Any) -> dict[str, str]:
        await asyncio.sleep(10.0)
        return {"id": "never"}

    client = SpeechmaticsClient(
        {
            "apiKey": "test-api-key",
            "submitTimeoutMs": 5,
            "batchClient": _MockBatchClient(createTranscriptionJob=never_finish),
        }
    )
    with pytest.raises(RuntimeError, match="Speechmatics upload timed out after 5ms"):
        await client.submit_job({"audio": bytes([1, 2, 3]), "filename": "test.m4a"})


async def test_submits_transcription_job_with_audio_and_speakers() -> None:
    captured_input: dict[str, Any] = {}
    captured_config: dict[str, Any] = {}

    async def create_job(inp: dict[str, Any], cfg: dict[str, Any]) -> dict[str, str]:
        nonlocal captured_input, captured_config
        captured_input = inp
        captured_config = cfg
        return {"id": "job-sm-123"}

    client = SpeechmaticsClient(
        {
            "apiKey": "test-api-key",
            "batchClient": _MockBatchClient(createTranscriptionJob=create_job),
        }
    )

    result = await client.submit_job(
        {
            "audio": bytes([1, 2, 3, 4]),
            "filename": "test.m4a",
            "mime": "audio/mp4",
            "language": "en",
            "speakers": [{"label": "Alice", "speaker_identifiers": ["id-1", "id-2"]}],
            "webhookUrl": "https://olive.test/api/webhooks/speechmatics",
            "webhookSecret": "secret-abc",
        }
    )

    assert result == {"id": "job-sm-123"}
    assert captured_input["fileName"] == "test.m4a"
    assert captured_config["transcription_config"]["language"] == "en"
    assert captured_config["transcription_config"]["diarization"] == "speaker"
    assert captured_config["transcription_config"]["speaker_diarization_config"]["speakers"] == [
        {"label": "Alice", "speaker_identifiers": ["id-1", "id-2"]}
    ]
    assert captured_config["notification_config"] == [
        {
            "url": "https://olive.test/api/webhooks/speechmatics",
            "contents": ["transcript"],
            "auth_headers": ["Authorization: Bearer secret-abc"],
        }
    ]


async def test_fetches_job_status_transcript_and_deletes_job() -> None:
    deleted_id = ""

    async def get_job(jid: str) -> dict[str, Any]:
        return {
            "job": {
                "id": jid,
                "status": "done",
                "created_at": "2026-08-16T00:00:00Z",
                "data_name": "test.m4a",
                "duration": 12,
            }
        }

    async def get_job_result(jid: str, fmt: str) -> Any:
        if fmt == "json-v2":
            return {"format": "2.0", "results": []}
        return "Alice: Hello world"

    async def delete_job(jid: str) -> dict[str, Any]:
        nonlocal deleted_id
        deleted_id = jid
        return {"job": {"id": jid, "status": "deleted", "created_at": "", "data_name": ""}}

    client = SpeechmaticsClient(
        {
            "apiKey": "test-api-key",
            "batchClient": _MockBatchClient(
                getJob=get_job,
                getJobResult=get_job_result,
                deleteJob=delete_job,
            ),
        }
    )

    job = await client.get_job("job-123")
    assert job["status"] == "done"

    transcript = await client.get_transcript("job-123", "json-v2")
    assert transcript["format"] == "2.0"

    text_transcript = await client.get_transcript("job-123", "txt")
    assert text_transcript == "Alice: Hello world"

    await client.delete_job("job-123")
    assert deleted_id == "job-123"
