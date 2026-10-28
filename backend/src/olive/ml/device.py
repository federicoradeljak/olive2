"""Compute-device selection for the local ML stack.

``OLIVE_ML_DEVICE`` is ``cpu`` (default), ``cuda`` or ``auto`` (cuda when
torch sees a GPU). The local server keeps running on CPU; the Modal GPU
worker sets ``cuda``.
"""

from __future__ import annotations

import os

_CPU_PROVIDERS = ["CPUExecutionProvider"]
_CUDA_PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]


def resolve_device() -> str:
    """Returns ``"cuda"`` or ``"cpu"`` for torch / ONNX placement."""
    raw = (os.environ.get("OLIVE_ML_DEVICE") or "cpu").strip().lower()
    if raw == "cuda":
        return "cuda"
    if raw == "auto":
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"
    return "cpu"


def onnx_providers() -> list[str]:
    """ONNX Runtime execution providers for the resolved device."""
    return list(_CUDA_PROVIDERS if resolve_device() == "cuda" else _CPU_PROVIDERS)
