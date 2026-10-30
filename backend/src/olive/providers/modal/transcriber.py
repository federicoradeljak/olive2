"""The Modal GPU worker behind the cloud transcriber seam.

The worker runs the local pipeline remotely (``modal_app/olive_gpu.py``) and
returns generic ``Speaker N`` clusters; voiceprint matching stays local in the
cloud run's persistence. Spend is the measured worker GPU time, so the result
carries its own usage instead of the per-hour-of-audio estimate.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Callable
from typing import Any

from ...ml.asr_registry import normalize_asr_model
from ...schemas import Transcript
from ...services.cloud_transcription import (
    CLOUD_PROVIDERS,
    CloudJob,
    CloudTranscript,
    TranscriptionCancelled,
    title_implies_two_speakers,
)
from ...services.usage import estimate_modal_gpu_cost
from .audio import prepare_modal_flac
from .client import ModalCancelledError, ModalClient

# (language, meeting_id, engine) -> a language the engine can take; Cohere
# cannot auto-detect, so the service maps ``auto`` to English (and logs it).
FixedLanguage = Callable[[Any, str, str], Any]


class ModalTranscriber:
    spec = CLOUD_PROVIDERS["modal"]

    def __init__(
        self,
        client: ModalClient,
        *,
        default_asr_model: Callable[[], Any],
        fixed_language: FixedLanguage,
    ) -> None:
        self.client = client
        self.default_asr_model = default_asr_model
        self.fixed_language = fixed_language

    async def transcribe(self, job: CloudJob) -> CloudTranscript:
        opts = job.options
        job.set_job_id(f"modal-{job.meeting_id[:8]}-{uuid.uuid4().hex[:8]}")
        asr_model = normalize_asr_model(opts.get("asrModel") or opts.get("asr_model") or self.default_asr_model())

        await job.progress("uploading", 10, "Converting audio for the Modal GPU worker (16 kHz FLAC)...")
        audio_bytes = await asyncio.to_thread(prepare_modal_flac, job.audio_path)
        job.raise_if_aborted()

        expected_speaker_count = opts.get("expectedSpeakerCount") or (
            2 if title_implies_two_speakers(job.meeting["title"]) else None
        )
        await job.progress("transcribing", 20, f"Transcribing on Modal GPU ({asr_model})...")
        try:
            result = await self.client.transcribe(
                audio_bytes,
                {
                    "asrModel": asr_model,
                    "language": (
                        self.fixed_language(opts.get("language"), job.meeting_id, "modal:cohere")
                        if asr_model == "cohere"
                        else opts.get("language")
                    ),
                    "modelId": opts.get("modelId"),
                    "wholeFileAsr": bool(opts.get("wholeFileAsr")),
                    "expectedSpeakerCount": expected_speaker_count,
                    "clusteringThreshold": opts.get("clusteringThreshold"),
                    # Only Whisper can be biased; Cohere has no prompt hook.
                    "additionalVocab": None if asr_model == "cohere" else job.additional_vocab,
                },
                signal=job.signal,
                on_spawned=job.set_job_id,
            )
        except ModalCancelledError as exc:
            raise TranscriptionCancelled() from exc
        except Exception as exc:
            raise RuntimeError(f"Modal transcription failed: {exc}") from exc

        try:
            canonical = Transcript.model_validate(result.get("transcript") or {})
        except Exception as exc:
            raise RuntimeError(f"Modal returned an invalid transcript: {exc}") from exc

        timings: dict[str, float] = {
            str(k): float(v)
            for k, v in dict(result.get("timings") or {}).items()
            if isinstance(v, int | float)
        }
        gpu = str(result.get("gpu") or "")
        gpu_seconds = float(timings.get("loadSec") or 0.0) + float(timings.get("runSec") or 0.0)
        usage = {
            "recording_id": job.recording["id"],
            "audio_seconds": (canonical.durationMs / 1000.0) if canonical.durationMs else None,
            "source": f"modal:{job.job_id}",
            "model": str(result.get("asrModel") or asr_model),
            "cost_usd": estimate_modal_gpu_cost(gpu, gpu_seconds),
            "detail": {
                "gpu": gpu,
                "gpuSeconds": round(gpu_seconds, 3),
                "timings": timings,
                "functionCallId": job.job_id,
            },
        }
        await job.progress("finalizing", 75, "Modal transcription complete. Identifying speakers...")
        return CloudTranscript(canonical, usage=usage)

    async def release(self, job_id: str) -> None:
        return None
