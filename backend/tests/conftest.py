"""Pytest configuration for Olive backend test suite."""

from __future__ import annotations

import os

os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")
