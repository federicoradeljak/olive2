"""Pytest configuration for Olive backend test suite."""

from __future__ import annotations

import os
import tempfile

import pytest

from olive.settings import resolve_paths

# Never touch ~/.config/olive (AGENTS.md rule 1): anything resolving the
# default paths — e.g. the DB logger before a test installs its own handle —
# lands in a throwaway dir. Models stay where they are so live tests find them.
os.environ.setdefault("OLIVE_MODELS_DIR", resolve_paths().models_dir)
os.environ.setdefault("OLIVE_CONFIG_DIR", tempfile.mkdtemp(prefix="olive-tests-"))

os.environ.setdefault("OTEL_SDK_DISABLED", "true")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """Skip `live`-marked tests unless explicitly opted in.

    Live tests hit real ML models (multi-GB downloads + CPU inference) or
    external APIs. Run them with ``OLIVE_RUN_LIVE_TESTS=1``.
    """
    if os.environ.get("OLIVE_RUN_LIVE_TESTS") == "1":
        return
    skip_live = pytest.mark.skip(
        reason="live test (downloads real ML models); set OLIVE_RUN_LIVE_TESTS=1 to run"
    )
    for item in items:
        if "live" in item.keywords:
            item.add_marker(skip_live)
