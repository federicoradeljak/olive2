"""Changelog API and build identity tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from olive import build_info
from olive.app import create_app
from olive.db import create_db


def test_changelog_api_returns_build_display_and_markdown() -> None:
    handle = create_db(":memory:")
    app = create_app({"db": handle.engine})
    client = TestClient(app)

    res = client.get("/api/changelog")
    assert res.status_code == 200
    data = res.json()
    # "version" is the build identity (date/time/commit), not a release number.
    assert data["version"] == build_info.get_build_display()
    assert isinstance(data["version"], str) and data["version"]
    assert isinstance(data["markdown"], str)
    assert "# Changelog" in data["markdown"]

    handle.engine.dispose()


def test_build_display_prefers_env_override(monkeypatch) -> None:
    monkeypatch.delenv("OLIVE_BUILD_TAG", raising=False)
    monkeypatch.setenv("OLIVE_BUILD_SHA", "abc123def456789")
    monkeypatch.setenv("OLIVE_BUILD_DATE", "2026-10-15T14:32:11+00:00")
    build_info.get_build_info.cache_clear()
    try:
        assert build_info.get_build_display() == "2026-10-15 14:32 UTC · abc123d"
    finally:
        build_info.get_build_info.cache_clear()


def test_build_display_prefers_release_tag(monkeypatch) -> None:
    monkeypatch.setenv("OLIVE_BUILD_TAG", "2026.10.15")
    monkeypatch.setenv("OLIVE_BUILD_SHA", "abc123def456789")
    monkeypatch.setenv("OLIVE_BUILD_DATE", "2026-10-15T14:32:11+00:00")
    build_info.get_build_info.cache_clear()
    try:
        assert build_info.get_build_display() == "2026.10.15 · abc123d"
    finally:
        build_info.get_build_info.cache_clear()
        monkeypatch.delenv("OLIVE_BUILD_TAG", raising=False)


def test_build_display_falls_back_to_unknown(monkeypatch) -> None:
    monkeypatch.delenv("OLIVE_BUILD_TAG", raising=False)
    monkeypatch.delenv("OLIVE_BUILD_SHA", raising=False)
    monkeypatch.delenv("OLIVE_BUILD_DATE", raising=False)
    monkeypatch.setattr(build_info, "_git_output", lambda *args: None)
    build_info.get_build_info.cache_clear()
    try:
        assert build_info.get_build_display() == "unknown build"
    finally:
        build_info.get_build_info.cache_clear()
