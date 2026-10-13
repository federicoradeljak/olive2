"""CTC forced alignment for word-level timestamps using ctc-forced-aligner (MMS-300m ONNX)."""

from __future__ import annotations

import asyncio
import gc
import os
import re
import threading
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort

from ..schemas import TranscriptWord
from ..settings import resolve_paths
from .audio import resample

_ALIGN_LOCK = threading.Lock()
_CACHED_ALIGNER: dict[tuple[str, int], tuple[ort.InferenceSession, Any]] = {}

ISO639_1_TO_3: dict[str, str] = {
    "en": "eng",
    "fr": "fra",
    "de": "deu",
    "es": "spa",
    "it": "ita",
    "pt": "por",
    "nl": "nld",
    "pl": "pol",
    "el": "ell",
    "ar": "ara",
    "ja": "jpn",
    "zh": "cmn",
    "vi": "vie",
    "ko": "kor",
    "ru": "rus",
    "tr": "tur",
}


def proportional_word_timestamps(
    text: str,
    start_ms: int,
    duration_ms: int,
    speaker: str | None = None,
) -> list[TranscriptWord]:
    words = [w for w in re.split(r"\s+", text.strip()) if w]
    if not words:
        return []
    word_dur = max(1, duration_ms // len(words))
    out: list[TranscriptWord] = []
    for idx, w in enumerate(words):
        w_start = start_ms + idx * word_dur
        w_end = start_ms + (idx + 1) * word_dur if idx < len(words) - 1 else start_ms + duration_ms
        out.append(
            TranscriptWord(
                word=w,
                startMs=w_start,
                endMs=max(w_start, w_end),
                speaker=speaker,
            )
        )
    return out


class CtcForcedAligner:
    """Word-level forced aligner powered by ctc-forced-aligner (MMS-300m ONNX)."""

    def __init__(self, options: dict[str, Any] | None = None, **kwargs: Any) -> None:
        opts = {**(options or {}), **kwargs}
        self.model_path: str | None = opts.get("modelPath") or opts.get("model_path")
        self.num_threads: int = int(opts.get("numThreads") or max(2, min(8, (os.cpu_count() or 4) // 2)))
        self._session: ort.InferenceSession | None = None
        self._tokenizer: Any = None

    def _ensure_loaded_sync(self) -> tuple[ort.InferenceSession, Any]:
        if self._session is not None and self._tokenizer is not None:
            return self._session, self._tokenizer

        with _ALIGN_LOCK:
            if self._session is not None and self._tokenizer is not None:
                return self._session, self._tokenizer

            from ctc_forced_aligner import MODEL_URL, Tokenizer, ensure_onnx_model

            path = self.model_path
            if not path:
                models_dir = Path(resolve_paths().models_dir) / "aligner"
                models_dir.mkdir(parents=True, exist_ok=True)
                path = str(models_dir / "mms-300m-aligner.onnx")
                self.model_path = path

            cache_key = (path, self.num_threads)
            if cache_key in _CACHED_ALIGNER:
                self._session, self._tokenizer = _CACHED_ALIGNER[cache_key]
                return self._session, self._tokenizer

            ensure_onnx_model(path, MODEL_URL)
            sess_opts = ort.SessionOptions()
            sess_opts.intra_op_num_threads = self.num_threads
            sess_opts.inter_op_num_threads = 1
            sess_opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

            self._session = ort.InferenceSession(path, sess_opts, providers=["CPUExecutionProvider"])
            self._tokenizer = Tokenizer()
            _CACHED_ALIGNER[cache_key] = (self._session, self._tokenizer)
            return self._session, self._tokenizer

    def _align_sync(
        self,
        samples: np.ndarray,
        sample_rate: int,
        text: str,
        language: str = "en",
        offset_ms: int = 0,
    ) -> list[TranscriptWord]:
        clean_text = text.strip()
        if not clean_text:
            return []

        arr = np.asarray(samples, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr.mean(axis=1).astype(np.float32)
        if sample_rate != 16000:
            arr = resample(arr, sample_rate, 16000)

        duration_ms = int(round((len(arr) / 16000.0) * 1000))
        if len(arr) < 1600:
            return proportional_word_timestamps(clean_text, offset_ms, duration_ms)

        try:
            from ctc_forced_aligner import (
                generate_emissions,
                get_alignments,
                get_spans,
                postprocess_results,
                preprocess_text,
            )

            session, tokenizer = self._ensure_loaded_sync()
            iso3 = ISO639_1_TO_3.get(language.lower()[:2], "eng")
            emissions, stride = generate_emissions(session, arr, batch_size=4)
            tokens_starred, text_starred = preprocess_text(clean_text, romanize=True, language=iso3)
            segments, scores, blank_token = get_alignments(emissions, tokens_starred, tokenizer)
            spans = get_spans(tokens_starred, segments, blank_token)
            stamps = postprocess_results(text_starred, spans, stride, scores)

            orig_words = [w for w in re.split(r"\s+", clean_text) if w]
            out: list[TranscriptWord] = []
            for idx, st in enumerate(stamps):
                w_text = orig_words[idx] if idx < len(orig_words) else str(st.get("text") or "").strip()
                if not w_text:
                    continue
                s_ms = offset_ms + int(round(float(st.get("start", 0.0)) * 1000))
                e_ms = offset_ms + int(round(float(st.get("end", 0.0)) * 1000))
                conf = st.get("score")
                out.append(
                    TranscriptWord(
                        word=w_text,
                        startMs=s_ms,
                        endMs=max(s_ms, e_ms),
                        confidence=float(conf) if conf is not None else None,
                    )
                )
            if out:
                return out
        except Exception:
            pass

        return proportional_word_timestamps(clean_text, offset_ms, duration_ms)

    async def align(
        self,
        samples: np.ndarray,
        sample_rate: int,
        text: str,
        language: str = "en",
        offset_ms: int = 0,
    ) -> list[TranscriptWord]:
        return await asyncio.to_thread(self._align_sync, samples, sample_rate, text, language, offset_ms)

    def release(self, clear_cache: bool = False) -> None:
        with _ALIGN_LOCK:
            self._session = None
            self._tokenizer = None
            if clear_cache:
                _CACHED_ALIGNER.clear()
                gc.collect()
