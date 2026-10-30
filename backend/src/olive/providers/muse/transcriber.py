"""Muse Voice behind the cloud transcriber seam: chunked 24 kHz WAV requests."""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from ...services.cloud_transcription import CLOUD_PROVIDERS, CloudJob, CloudTranscript
from .audio import prepare_muse_wav_chunks
from .client import MuseClient
from .normalize import merge_muse_chunk_transcripts
from .types import MuseTranscribeResponse


class MuseTranscriber:
    spec = CLOUD_PROVIDERS["muse"]

    def __init__(self, client: MuseClient) -> None:
        self.client = client

    async def transcribe(self, job: CloudJob) -> CloudTranscript:
        session_id = f"muse-{job.meeting_id[:8]}-{uuid.uuid4().hex[:8]}"
        job.set_job_id(session_id)

        await job.progress("uploading", 12, "Converting audio for Muse Voice (24 kHz WAV)...")
        chunks = await asyncio.to_thread(prepare_muse_wav_chunks, job.audio_path)
        job.raise_if_aborted()

        mode = str(job.options.get("mode") or "DIARIZATION")
        raw_responses: list[MuseTranscribeResponse | dict[str, Any]] = []
        chunk_offsets: list[int] = []
        for index, (wav_bytes, offset_ms) in enumerate(chunks):
            job.raise_if_aborted()
            pct = 15.0 + 55.0 * (index / max(1, len(chunks)))
            await job.progress(
                "transcribing",
                pct,
                f"Transcribing with Muse Voice (chunk {index + 1}/{len(chunks)})...",
            )
            raw = await self.client.transcribe_wav(
                wav_bytes,
                {
                    "mode": mode,
                    "language": job.options.get("language"),
                    "additionalVocab": job.additional_vocab,
                    "sessionId": f"{session_id}-{index}",
                    "filename": f"muse-chunk-{index}.wav",
                },
            )
            raw_responses.append(raw)
            chunk_offsets.append(offset_ms)

        await job.progress("finalizing", 72, "Muse transcription complete. Identifying speakers...")
        # Labels are request-scoped: the same letter in two chunks may be
        # different people, so merge assigns globally unique Speaker N
        # clusters and lets voiceprint matching reconcile identities.
        return CloudTranscript(merge_muse_chunk_transcripts(raw_responses, chunk_offsets))

    async def release(self, job_id: str) -> None:
        return None
