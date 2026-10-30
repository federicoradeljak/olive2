"""Meeting storage: folder layout, audio lookup and folder moves."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.engine import Engine

from olive.db import create_db
from olive.layout import meeting_folder_name
from olive.meeting_storage import MeetingStorage, first_recording

MEETING: dict[str, Any] = {"id": "abcdef12-3456", "title": "Weekly Sync", "start_time": 1_700_000_000_000}


@pytest.fixture
def db() -> Iterator[Engine]:
    handle = create_db(":memory:")
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO meetings (id, title, start_time, end_time, source, status, tags, "
                "created_at, updated_at) VALUES (:id, :title, :start, :start, 'upload', "
                "'ready', '[]', 0, 0)"
            ),
            {"id": MEETING["id"], "title": MEETING["title"], "start": MEETING["start_time"]},
        )
    yield handle.engine
    handle.engine.dispose()


def _add_recording(db: Engine, recording_id: str, path: str, created_at: int) -> None:
    with db.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO recordings (id, meeting_id, path, mime, size_bytes, sha256, provider, created_at) "
                "VALUES (:id, :mid, :path, 'audio/mp4', 5, :id, 'upload', :created)"
            ),
            {"id": recording_id, "mid": MEETING["id"], "path": path, "created": created_at},
        )


def test_folder_keeps_the_layout_name(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)

    folder = storage.folder(MEETING)

    assert folder == tmp_path / meeting_folder_name(MEETING["start_time"], MEETING["title"], MEETING["id"])
    assert folder.name == "2023-11-14_Weekly_Sync__abcdef12"


def test_ensure_creates_the_artifact_dirs(tmp_path: Path) -> None:
    paths = MeetingStorage(tmp_path).ensure(MEETING)

    assert Path(paths.audio_dir).is_dir()
    assert Path(paths.transcripts_dir).is_dir()
    assert Path(paths.summaries_dir).is_dir()


def test_read_text_is_none_for_a_missing_file(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    storage.ensure(MEETING)
    storage.file(MEETING, "transcripts/local.txt").write_text("hello", encoding="utf-8")

    assert storage.read_text(MEETING, "transcripts/local.txt") == "hello"
    assert storage.read_text(MEETING, "transcripts/missing.txt") is None


def test_audio_is_the_first_recording_on_disk(db: Engine, tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    storage.ensure(MEETING)
    _add_recording(db, "later", "audio/later.m4a", created_at=2)
    _add_recording(db, "first", "audio/first.m4a", created_at=1)
    storage.file(MEETING, "audio/first.m4a").write_bytes(b"audio")

    with db.connect() as conn:
        recording = first_recording(conn, MEETING["id"])
        audio = storage.audio(conn, MEETING)

    assert recording is not None and recording["id"] == "first"
    assert audio == storage.file(MEETING, "audio/first.m4a")


def test_audio_is_none_when_the_file_is_missing(db: Engine, tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    _add_recording(db, "rec", "audio/rec.m4a", created_at=1)

    with db.connect() as conn:
        assert storage.audio(conn, MEETING) is None
        assert storage.audio(conn, {**MEETING, "id": "no-recordings"}) is None


def test_drop_enhanced_audio_keeps_the_source(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    storage.ensure(MEETING)
    storage.file(MEETING, "audio/rec.m4a").write_bytes(b"audio")
    storage.file(MEETING, "audio/other.enhanced.mp3").write_bytes(b"keep")
    storage.enhanced_audio_path(MEETING, "rec").write_bytes(b"mp3")
    storage.file(MEETING, "audio/rec.enhanced.wav").write_bytes(b"wav")

    storage.drop_enhanced_audio(MEETING, "rec")

    remaining = sorted(p.name for p in (storage.folder(MEETING) / "audio").iterdir())
    assert remaining == ["other.enhanced.mp3", "rec.m4a"]


def test_drop_enhanced_audio_without_a_folder_is_a_no_op(tmp_path: Path) -> None:
    # Split and merge must never fail on this cleanup.
    MeetingStorage(tmp_path).drop_enhanced_audio(MEETING, "rec")


def test_relocate_moves_the_folder_to_the_new_title(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    storage.ensure(MEETING)
    renamed = {**MEETING, "title": "Renamed"}

    with storage.relocate(MEETING, title="Renamed"):
        pass

    assert not storage.folder(MEETING).exists()
    assert storage.folder(renamed).is_dir()


def test_relocate_moves_back_when_the_block_fails(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    storage.ensure(MEETING)
    shifted = {**MEETING, "start_time": MEETING["start_time"] + 86_400_000}

    with pytest.raises(ValueError), storage.relocate(MEETING, start_time=shifted["start_time"]):
        assert storage.folder(shifted).is_dir()
        raise ValueError("db update failed")

    assert storage.folder(MEETING).is_dir()
    assert not storage.folder(shifted).exists()


def test_relocate_refuses_to_overwrite_an_existing_folder(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    storage.ensure(MEETING)
    storage.ensure({**MEETING, "title": "Taken"})

    with pytest.raises(RuntimeError, match="already exists"), storage.relocate(MEETING, title="Taken"):
        pass

    assert storage.folder(MEETING).is_dir()


def test_relocate_without_a_folder_is_a_no_op(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)

    with storage.relocate(MEETING, title="Renamed"):
        pass

    assert not any(tmp_path.iterdir())


def test_delete_removes_the_folder(tmp_path: Path) -> None:
    storage = MeetingStorage(tmp_path)
    storage.ensure(MEETING)

    storage.delete(MEETING)

    assert not storage.folder(MEETING).exists()
