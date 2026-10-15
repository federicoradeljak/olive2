"""Deleted Plaud recordings must not resurrect on the next poll/restart."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from sqlalchemy import text

from olive.db import create_db
from olive.plaud import PlaudPoller
from olive.services.meetings import delete_meeting

AUDIO_BYTES = b"fake plaud audio"
FIXTURE_FILE: dict[str, Any] = {
    "id": "plaud-file-zombie-1",
    "name": "Zombie planning",
    "created_at": "2026-09-29T15:03:11.000Z",
    "start_at": "2026-09-29T15:03:11.000Z",
    "duration": 12,
}


def _ready_detail() -> dict[str, Any]:
    return {
        **FIXTURE_FILE,
        "presigned_url": "https://audio.test/zombie.m4a",
        "source_list": [
            {
                "data_type": "transcript",
                "data_content": json.dumps(
                    [
                        {
                            "start_time": 0,
                            "end_time": 5000,
                            "speaker": "Alice",
                            "content": "Let's ship it.",
                        }
                    ]
                ),
            }
        ],
        "note_list": [],
    }


class _FakeOAuth:
    async def getAccessToken(self) -> str:
        return "fake-token"


class _FakePlaudClient:
    oauth = _FakeOAuth()

    async def getCurrentUser(self) -> dict[str, str]:
        return {"id": "fake-user"}

    async def listFilesIterator(self, _opts: Any = None) -> AsyncIterator[dict[str, Any]]:
        yield FIXTURE_FILE

    async def getFile(self, _fid: str) -> dict[str, Any]:
        return _ready_detail()


class _FakeResponse:
    def __init__(self, content: bytes = AUDIO_BYTES) -> None:
        self.content = content
        self.status = 200
        self.headers = {"content-type": "audio/mp4"}

    @property
    def ok(self) -> bool:
        return True

    async def arrayBuffer(self) -> bytes:
        return self.content


async def test_deleted_plaud_recording_is_not_rediscovered(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    poller = PlaudPoller(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "client": _FakePlaudClient(),
            "fetchImpl": lambda _url: _FakeResponse(),
            "now": lambda: 1_000_000,
        }
    )

    first = await poller.trigger()
    assert first["discovered"] == 1
    with handle.engine.connect() as conn:
        meeting_id = conn.execute(text("SELECT id FROM meetings")).mappings().one()["id"]

    assert delete_meeting(handle.engine, meeting_id, meetings_dir) is True

    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM meetings")).fetchall() == []
        tombstone = conn.execute(text("SELECT * FROM plaud_deleted_files")).mappings().all()
        assert len(tombstone) == 1

    # Same cloud file still listed by Plaud, but the tombstone suppresses it.
    second = await poller.trigger()
    assert second["discovered"] == 0
    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM meetings")).fetchall() == []
    handle.engine.dispose()


async def test_deleted_plaud_recording_suppressed_across_id_forms(tmp_path: Path) -> None:
    """Bare-hex deletes must suppress the of_-prefixed form (and vice versa)."""
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    poller = PlaudPoller(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "client": _FakePlaudClient(),
            "fetchImpl": lambda _url: _FakeResponse(),
            "now": lambda: 1_000_000,
        }
    )

    await poller.trigger()
    with handle.engine.connect() as conn:
        meeting_id = conn.execute(text("SELECT id FROM meetings")).mappings().one()["id"]
    assert delete_meeting(handle.engine, meeting_id, meetings_dir) is True

    prefixed = FIXTURE_FILE["id"] if FIXTURE_FILE["id"].startswith("of_") else f"of_{FIXTURE_FILE['id']}"

    class _PrefixedClient(_FakePlaudClient):
        async def listFilesIterator(self, _opts: Any = None) -> AsyncIterator[dict[str, Any]]:
            yield {**FIXTURE_FILE, "id": prefixed}

    prefixed_poller = PlaudPoller(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "client": _PrefixedClient(),
            "fetchImpl": lambda _url: _FakeResponse(),
            "now": lambda: 1_000_000,
        }
    )
    res = await prefixed_poller.trigger()
    assert res["discovered"] == 0
    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM meetings")).fetchall() == []
    handle.engine.dispose()
