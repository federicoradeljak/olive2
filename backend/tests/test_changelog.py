"""Changelog API tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from olive import __version__
from olive.app import create_app
from olive.db import create_db


def test_changelog_api_returns_version_and_markdown() -> None:
    handle = create_db(":memory:")
    app = create_app({"db": handle.engine})
    client = TestClient(app)

    res = client.get("/api/changelog")
    assert res.status_code == 200
    data = res.json()
    assert data["version"] == __version__
    assert isinstance(data["markdown"], str)
    assert "# Changelog" in data["markdown"]

    handle.engine.dispose()
