"""Whisper ASR backend (faster-whisper / CTranslate2) implementing AsrBackend.

Used by the Modal GPU worker. ``faster_whisper`` is imported lazily and is not
a dependency of the local server — only the Modal image installs it. Whisper
returns native word timestamps, so the pipeline transcribes the whole file in
one pass and skips CTC forced alignment (``provides_word_timestamps``).
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from typing import Any

import numpy as np

from ..schemas import TranscriptWord
from ..settings import resolve_paths
from .audio import resample
from .device import resolve_device

WHISPER_MODEL_NAMES: dict[str, str] = {
    "whisper-large-v3-turbo": "large-v3-turbo",
    "whisper-large-v3": "large-v3",
}


def whisper_download_root() -> str:
    return str(Path(resolve_paths().models_dir) / "whisper")


def _whisper_model_class() -> Any:
    from faster_whisper import WhisperModel  # pyright: ignore[reportMissingImports]

    return WhisperModel


class FasterWhisperAsrEngine:
    """Whole-file Whisper transcription with native word timestamps."""

    provides_word_timestamps = True

    def __init__(self, model: str = "whisper-large-v3-turbo", config: dict[str, Any] | None = None) -> None:
        if model not in WHISPER_MODEL_NAMES:
            raise ValueError(f"Unknown Whisper model: {model}")
        cfg = config or {}
        self.model = model
        self.device: str = str(cfg.get("device") or resolve_device())
        self.compute_type: str = str(
            cfg.get("computeType") or ("float16" if self.device == "cuda" else "int8")
        )
        self.beam_size: int = int(cfg.get("beamSize") or 5)
        self._model: Any = None
        self._lock = threading.Lock()

    def _load(self) -> Any:
        with self._lock:
            if self._model is None:
                self._model = _whisper_model_class()(
                    WHISPER_MODEL_NAMES[self.model],
                    device=self.device,
                    compute_type=self.compute_type,
                    download_root=whisper_download_root(),
                )
            return self._model

    def _transcribe_sync(self, samples: np.ndarray, language: str | None, start_ms: int) -> dict[str, Any]:
        model = self._load()
        segments, _info = model.transcribe(
            samples,
            language=language,
            beam_size=self.beam_size,
            word_timestamps=True,
            vad_filter=True,
        )
        words: list[TranscriptWord] = []
        texts: list[str] = []
        for seg in segments:
            seg_text = str(getattr(seg, "text", "") or "").strip()
            if seg_text:
                texts.append(seg_text)
            for w in getattr(seg, "words", None) or []:
                token = str(getattr(w, "word", "") or "").strip()
                if not token:
                    continue
                w_start = start_ms + int(round(float(w.start) * 1000))
                w_end = max(w_start, start_ms + int(round(float(w.end) * 1000)))
                prob = getattr(w, "probability", None)
                words.append(
                    TranscriptWord(
                        word=token,
                        startMs=w_start,
                        endMs=w_end,
                        confidence=float(prob) if prob is not None else None,
                    )
                )
        return {"text": " ".join(texts).strip(), "words": words}

    async def transcribe_segment(
        self,
        samples: np.ndarray | list[float],
        sample_rate: int = 16000,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {}
        arr = np.asarray(samples, dtype=np.float32)
        if arr.size == 0:
            return {"text": "", "words": []}
        if sample_rate != 16000:
            arr = resample(arr, sample_rate, 16000)
        raw_lang = str(opts.get("language") or "").strip().lower()
        language = None if raw_lang in ("", "auto") else raw_lang
        start_ms = int(opts.get("startMs") or opts.get("start_ms") or 0)
        return await asyncio.to_thread(self._transcribe_sync, arr, language, start_ms)

    def release(self) -> None:
        with self._lock:
            self._model = None
