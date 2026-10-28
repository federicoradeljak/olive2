"""Result shape returned by the Modal GPU worker (``modal_app/olive_gpu.py``)."""

from __future__ import annotations

from typing import Any, TypedDict


class ModalTimings(TypedDict, total=False):
    loadSec: float
    diarizeSec: float
    asrSec: float
    runSec: float


class ModalTranscribeResult(TypedDict, total=False):
    transcript: dict[str, Any]
    asrModel: str
    gpu: str
    timings: ModalTimings
    functionCallId: str
