"""Plaud recording intake: reuse, dedupe by hash, or write the audio."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from olive.db import create_db
from olive.layout import meeting_paths
from olive.plaud.intake import DownloadedAudio, DuplicateAudioError, RecordingIntake

AUDIO = b"plaud audio"


def _meeting(meeting_id: str) -> dict[str, Any]:
    return {"id": meeting_id, "title": f"Meeting {meeting_id}", "start_time": 1_000, "end_time": 13_000}


@pytest.fixture
def db() -> Iterator[Engine]:
    handle = create_db(":memory:")
    with handle.engine.begin() as conn:
        for meeting_id in ("m1", "m2"):
            conn.execute(
                text(
                    "INSERT INTO meetings (id, title, start_time, end_time, source, status, tags, "
                    "created_at, updated_at) VALUES (:id, :title, 1000, 13000, 'plaud', "
                    "'processing', '[]', 0, 0)"
                ),
                {"id": meeting_id, "title": f"Meeting {meeting_id}"},
            )
    yield handle.engine
    handle.engine.dispose()


class _Downloader:
    def __init__(self, content: bytes = AUDIO) -> None:
        self.content = content
        self.calls = 0

    async def __call__(self) -> DownloadedAudio:
        self.calls += 1
        return DownloadedAudio(
            bytes=self.content,
            extension="m4a",
            mime="audio/mp4",
            sha256=hashlib.sha256(self.content).hexdigest(),
        )


def _folder(tmp_path: Path, meeting_id: str) -> Path:
    meeting = _meeting(meeting_id)
    return Path(meeting_paths(tmp_path, meeting["start_time"], meeting["title"], meeting_id).folder)


def _recordings(db: Engine) -> list[dict[str, Any]]:
    with db.connect() as conn:
        rows = conn.execute(text("SELECT * FROM recordings ORDER BY created_at")).mappings().all()
    return [dict(row) for row in rows]


async def test_writes_a_new_recording(db: Engine, tmp_path: Path) -> None:
    intake = RecordingIntake(db, str(tmp_path), lambda: 5_000)
    download = _Downloader()

    stored = await intake.ensure(_meeting("m1"), "of_1", 12_000, download)

    assert stored.path == f"audio/{stored.id}.m4a"
    assert (_folder(tmp_path, "m1") / stored.path).read_bytes() == AUDIO
    [row] = _recordings(db)
    assert row["id"] == stored.id
    assert row["provider_recording_id"] == "of_1"
    assert row["duration_ms"] == 12_000
    assert row["size_bytes"] == len(AUDIO)
    assert row["created_at"] == 5_000


async def test_reuses_a_recording_still_on_disk_without_downloading(db: Engine, tmp_path: Path) -> None:
    intake = RecordingIntake(db, str(tmp_path), lambda: 5_000)
    first = await intake.ensure(_meeting("m1"), "of_1", 12_000, _Downloader())
    download = _Downloader()

    again = await intake.ensure(_meeting("m1"), "of_1", 12_000, download)

    assert again == first
    assert download.calls == 0


async def test_audio_owned_by_another_meeting_is_a_duplicate(db: Engine, tmp_path: Path) -> None:
    intake = RecordingIntake(db, str(tmp_path), lambda: 5_000)
    await intake.ensure(_meeting("m1"), "of_1", 12_000, _Downloader())

    with pytest.raises(DuplicateAudioError) as raised:
        await intake.ensure(_meeting("m2"), "of_2", 12_000, _Downloader())

    assert raised.value.duplicate_of_meeting_id == "m1"
    assert len(_recordings(db)) == 1


async def test_same_audio_under_a_new_plaud_id_is_relinked_and_restored(db: Engine, tmp_path: Path) -> None:
    intake = RecordingIntake(db, str(tmp_path), lambda: 5_000)
    first = await intake.ensure(_meeting("m1"), "legacy", 12_000, _Downloader())
    (_folder(tmp_path, "m1") / first.path).unlink()

    stored = await intake.ensure(_meeting("m1"), "of_legacy", 12_000, _Downloader())

    assert stored == first
    assert (_folder(tmp_path, "m1") / stored.path).read_bytes() == AUDIO
    [row] = _recordings(db)
    assert row["provider_recording_id"] == "of_legacy"


async def test_missing_file_with_new_audio_refreshes_the_recording(db: Engine, tmp_path: Path) -> None:
    intake = RecordingIntake(db, str(tmp_path), lambda: 5_000)
    first = await intake.ensure(_meeting("m1"), "of_1", 12_000, _Downloader())
    (_folder(tmp_path, "m1") / first.path).unlink()

    stored = await intake.ensure(_meeting("m1"), "of_1", 9_000, _Downloader(b"re-encoded audio"))

    assert stored.id == first.id
    assert (_folder(tmp_path, "m1") / stored.path).read_bytes() == b"re-encoded audio"
    [row] = _recordings(db)
    assert row["sha256"] == hashlib.sha256(b"re-encoded audio").hexdigest()
    assert row["duration_ms"] == 9_000
