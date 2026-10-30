"""AssemblyAI behind the cloud transcriber seam: upload, poll, normalize."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ...services.cloud_transcription import (
    CLOUD_PROVIDERS,
    CloudJob,
    CloudTranscript,
    TranscriptionCancelled,
)
from .client import AssemblyAIClient
from .normalize import parse_assemblyai_transcript


class AssemblyAITranscriber:
    spec = CLOUD_PROVIDERS["assemblyai"]

    def __init__(self, client: AssemblyAIClient, now: Callable[[], int] | None = None) -> None:
        self.client = client
        self.now = now or (lambda: int(time.time() * 1000))

    async def transcribe(self, job: CloudJob) -> CloudTranscript:
        opts = job.options
        await job.progress("uploading", 15, "Uploading audio to AssemblyAI (Universal-3.5 Pro)...")

        # Upload + submit with a heartbeat, since the upload is a single
        # request with no byte-level progress from the SDK.
        submit_task = asyncio.create_task(
            self.client.submit_job(
                {
                    "audio": {"path": job.audio_path},
                    "filename": Path(job.recording["path"]).name,
                    "language": opts.get("language"),
                    "additionalVocab": job.additional_vocab,
                }
            )
        )
        submit_start = self.now()
        while not submit_task.done():
            if job.aborted():
                submit_task.cancel()
                raise TranscriptionCancelled()
            done, _pending = await asyncio.wait({submit_task}, timeout=5.0)
            if done:
                break
            elapsed_s = int((self.now() - submit_start) / 1000)
            await job.progress("uploading", 15, f"Uploading audio to AssemblyAI... ({elapsed_s}s elapsed)")
        submitted = submit_task.result()

        job_id = str(submitted.get("id") or "") if isinstance(submitted, dict) else ""
        job.set_job_id(job_id)
        await job.progress(
            "transcribing", 25, f"Submitted to AssemblyAI (job {job_id[:8]}...). Processing..."
        )

        if (
            isinstance(submitted, dict)
            and submitted.get("status") == "completed"
            and (submitted.get("words") or submitted.get("utterances"))
        ):
            raw: Any = submitted
        else:
            raw = await self._poll(job, job_id)

        await job.progress("finalizing", 72, "AssemblyAI transcription complete. Identifying speakers...")
        return CloudTranscript(parse_assemblyai_transcript(raw))

    async def _poll(self, job: CloudJob, job_id: str) -> Any:
        interval_ms = int(job.options.get("pollIntervalMs") or 5000)
        max_wait_ms = int(job.options.get("maxPollWaitMs") or 3_600_000)
        duration_s = (job.recording.get("duration_ms") or 0) / 1000.0
        expected_s = min(900.0, max(45.0, duration_s / 8.0 if duration_s else 120.0))
        poll_start = self.now()
        poll_count = 0
        while self.now() - poll_start < max_wait_ms:
            job.raise_if_aborted()
            state = await self.client.get_transcript(job_id)
            status = str(state.get("status") or "") if isinstance(state, dict) else ""
            if status == "completed":
                return state
            if status == "error":
                raise RuntimeError(str(state.get("error") or "AssemblyAI transcription failed"))
            poll_count += 1
            elapsed_s = int((self.now() - poll_start) / 1000)
            if status == "queued":
                pct = 25.0
            else:
                pct = min(70.0, 25.0 + 45.0 * min(1.0, (elapsed_s / expected_s) if expected_s else 1.0))
            await job.progress(
                "transcribing",
                pct,
                f"AssemblyAI {status or 'processing'} (poll #{poll_count}, {elapsed_s}s elapsed)...",
            )
            await asyncio.sleep(interval_ms / 1000.0)
        raise RuntimeError(f"AssemblyAI job timed out after {max_wait_ms}ms")

    async def release(self, job_id: str) -> None:
        return None
