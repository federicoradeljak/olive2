"""Release-notes builder tests (scripts/release_notes.py, loaded by path)."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "release_notes.py"


def _load():
    spec = importlib.util.spec_from_file_location("release_notes", _SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


release_notes = _load()

SAMPLE = """# Changelog

Intro preamble.

## [2026-10-15]

### Added

- New thing.

## [2026-08-11 — 2026-10-14]

### Added

- Old thing.
"""


def test_tag_date_parsing() -> None:
    assert release_notes.parse_tag_date("2026.10.15") == "2026-10-15"
    assert release_notes.parse_tag_date("2026.10.15.1") == "2026-10-15"
    with pytest.raises(ValueError):
        release_notes.parse_tag_date("v2026.10.15")
    with pytest.raises(ValueError):
        release_notes.parse_tag_date("latest")


def test_selects_only_sections_newer_than_prev_tag() -> None:
    body = release_notes.build_body(
        tag="2026.10.15",
        image="ghcr.io/mcowger/olive2",
        changelog=SAMPLE,
        prev_tag="2026.10.14",
    )
    assert "docker pull ghcr.io/mcowger/olive2:2026.10.15" in body
    assert "Changes since `2026.10.14`" in body
    assert "New thing." in body
    assert "Old thing." not in body


def test_range_section_included_when_it_extends_past_prev_tag() -> None:
    body = release_notes.build_body(
        tag="2026.10.15",
        image="ghcr.io/mcowger/olive2",
        changelog=SAMPLE,
        prev_tag="2026.10.01",
    )
    assert "New thing." in body
    assert "Old thing." in body


def test_first_release_includes_everything() -> None:
    body = release_notes.build_body(
        tag="2026.10.15",
        image="ghcr.io/mcowger/olive2",
        changelog=SAMPLE,
        prev_tag=None,
    )
    assert "## Changelog" in body
    assert "New thing." in body
    assert "Old thing." in body


def test_falls_back_to_newest_section_when_nothing_is_newer() -> None:
    body = release_notes.build_body(
        tag="2026.10.15",
        image="ghcr.io/mcowger/olive2",
        changelog=SAMPLE,
        prev_tag="2026.10.15",
    )
    assert "New thing." in body
    assert "Old thing." not in body
