"""Speechmatics behind the cloud transcriber seam.

Without ``poll`` the job is only submitted and the webhook completes it
(``TranscriptionService.complete_transcription``); with ``poll`` the
transcriber waits for the job itself.
"""

from __future__ import annotations

import asyncio
import time
import urllib.parse
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ...services.cloud_transcription import CLOUD_PROVIDERS, CloudJob, CloudTranscript, Submitted
from .client import SpeechmaticsClient
from .normalize import parse_speechmatics_json_v2


class SpeechmaticsTranscriber:
    spec = CLOUD_PROVIDERS["speechmatics"]

    def __init__(
        self,
        client: SpeechmaticsClient,
        *,
        webhook_url: str | None = None,
        webhook_secret: str | None = None,
        now: Callable[[], int] | None = None,
    ) -> None:
        self.client = client
        self.webhook_url = webhook_url
        self.webhook_secret = webhook_secret
        self.now = now or (lambda: int(time.time() * 1000))

    async def transcribe(self, job: CloudJob) -> CloudTranscript | Submitted:
        opts = job.options
        await job.progress("decoding", 5, "Preparing audio and speaker profiles for Speechmatics...")

        # Speaker identity is resolved locally from voiceprints after ASR
        # (see _maybe_identify_cloud_speakers); Speechmatics is only asked
        # for diarized labels, not its native speaker_identifiers.
        webhook_url = (
            f"{self.webhook_url}?meetingId={urllib.parse.quote(job.meeting_id)}"
            f"&stageRunId={urllib.parse.quote(job.stage_run_id)}"
            if self.webhook_url
            else None
        )
        await job.progress("uploading", 15, "Uploading audio to Speechmatics Cloud API...")
        submitted = await self.client.submit_job(
            {
                "audio": {"path": job.audio_path},
                "filename": Path(job.recording["path"]).name,
                "mime": job.recording["mime"],
                "language": opts.get("language") or "en",
                "getSpeakers": True,
                "webhookUrl": webhook_url,
                "webhookSecret": self.webhook_secret,
                "additionalVocab": job.additional_vocab,
            }
        )
        job_id = str(submitted["id"])
        job.set_job_id(job_id)
        await job.progress(
            "transcribing", 25, f"Job {job_id[:10]}... accepted by Speechmatics. Cloud processing..."
        )

        if not opts.get("poll"):
            return Submitted(job_id)
        return self.parse(await self._poll(job, job_id))

    def parse(self, json_v2: dict[str, Any]) -> CloudTranscript:
        return CloudTranscript(parse_speechmatics_json_v2(json_v2), raw_payload=json_v2)

    async def _poll(self, job: CloudJob, job_id: str) -> dict[str, Any]:
        interval_ms = int(job.options.get("pollIntervalMs") or 2000)
        max_wait_ms = int(job.options.get("maxPollWaitMs") or 180_000)
        start_time = self.now()
        poll_count = 0
        while self.now() - start_time < max_wait_ms:
            job.raise_if_aborted()
            poll_count += 1
            elapsed_ms = self.now() - start_time
            elapsed_sec = int(round(elapsed_ms / 1000.0))
            await job.progress(
                "transcribing",
                min(70, int(round(20 + min(50.0, (elapsed_sec / 45.0) * 50.0)))),
                f"Speechmatics cloud processing (poll #{poll_count}, {elapsed_sec}s elapsed)...",
                currentMs=elapsed_ms,
            )
            status = await self.client.get_job(job_id)
            if status.get("status") == "done":
                await job.progress("finalizing", 72, "Downloading transcript JSON & identifying speakers...")
                return await self.client.get_transcript(job_id, "json-v2")
            if status.get("status") in ("rejected", "deleted"):
                errors = status.get("errors") or []
                raise RuntimeError(
                    "; ".join(e.get("message", "") for e in errors)
                    if errors
                    else f"Speechmatics job {status.get('status')}"
                )
            await asyncio.sleep(interval_ms / 1000.0)
        raise RuntimeError(f"Speechmatics job timed out after {max_wait_ms}ms")

    async def release(self, job_id: str) -> None:
        await self.client.delete_job(job_id)
