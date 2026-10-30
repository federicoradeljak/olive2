"""Where a meeting's files live on disk.

``MeetingStorage`` answers "where is this meeting's audio / artifact" from a
meeting row, so callers never rebuild the folder layout themselves. The
folder name (``layout.meeting_folder_name``) embeds the start date and title,
which is why renames and time shifts go through ``relocate``.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection

from .layout import MeetingPaths, ensure_meeting_folder, meeting_paths


def first_recording(conn: Connection, meeting_id: str) -> dict[str, Any] | None:
    """The meeting's oldest recording row: the one its audio is served from."""
    row = (
        conn.execute(
            text("SELECT * FROM recordings WHERE meeting_id = :mid ORDER BY created_at ASC LIMIT 1"),
            {"mid": meeting_id},
        )
        .mappings()
        .first()
    )
    return dict(row) if row else None


class MeetingStorage:
    """Owns the on-disk folder of each meeting under ``meetings_dir``.

    Meetings are passed as rows (``id``, ``title``, ``start_time``); paths in
    the ``recordings`` / ``artifacts`` tables are relative to the folder.
    """

    def __init__(self, meetings_dir: str | Path) -> None:
        self.meetings_dir = Path(meetings_dir)

    def paths(self, meeting: Mapping[Any, Any]) -> MeetingPaths:
        return meeting_paths(self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"])

    def folder(self, meeting: Mapping[Any, Any]) -> Path:
        return Path(self.paths(meeting).folder)

    def ensure(self, meeting: Mapping[Any, Any]) -> MeetingPaths:
        """The meeting's paths, creating its audio/transcripts/summaries dirs."""
        return ensure_meeting_folder(self.paths(meeting))

    def file(self, meeting: Mapping[Any, Any], rel_path: str) -> Path:
        """Absolute path of a file stored relative to the meeting folder."""
        return self.folder(meeting) / rel_path

    def read_text(self, meeting: Mapping[Any, Any], rel_path: str) -> str | None:
        """A stored text file's content, or ``None`` when it is not on disk."""
        path = self.file(meeting, rel_path)
        return path.read_text(encoding="utf-8") if path.exists() else None

    def audio_path(self, meeting: Mapping[Any, Any], recording: Mapping[Any, Any] | None) -> Path | None:
        """Absolute path of a recording's audio, or ``None`` when it is not on disk."""
        if not recording or not recording.get("path"):
            return None
        path = self.file(meeting, str(recording["path"]))
        return path if path.exists() else None

    def audio(self, conn: Connection, meeting: Mapping[Any, Any]) -> Path | None:
        """The meeting's audio file (its first recording), or ``None`` when missing."""
        return self.audio_path(meeting, first_recording(conn, str(meeting["id"])))

    def enhanced_audio_path(self, meeting: Mapping[Any, Any], recording_id: str) -> Path:
        """Where the cached voice-enhanced MP3 of a recording lives."""
        return self.file(meeting, f"audio/{recording_id}.enhanced.mp3")

    def drop_enhanced_audio(self, meeting: Mapping[Any, Any], recording_id: str) -> None:
        """Remove a recording's cached voice-enhanced derivatives.

        The audio route serves the enhanced file whenever it exists and the
        enhancer never rebuilds one, so whoever rewrites source audio in place
        (split, merge) must drop it or playback keeps the old audio.
        """
        audio_dir = self.folder(meeting) / "audio"
        candidates = {self.enhanced_audio_path(meeting, recording_id)}
        try:
            candidates.update(audio_dir.glob(f"{recording_id}.enhanced.*"))
        except OSError:
            pass
        for path in sorted(candidates):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    @contextmanager
    def relocate(
        self,
        meeting: Mapping[Any, Any],
        *,
        title: str | None = None,
        start_time: int | None = None,
    ) -> Iterator[None]:
        """Move the folder to match a new title / start time for the duration of the block.

        The folder is renamed before the block runs (refused when the target
        already exists) and renamed back if the block raises, so a failed DB
        update leaves the folder where the row still points.
        """
        moved_to = {
            **meeting,
            "title": meeting["title"] if title is None else title,
            "start_time": meeting["start_time"] if start_time is None else start_time,
        }
        old_folder = self.folder(meeting)
        new_folder = self.folder(moved_to)
        moved = old_folder != new_folder and old_folder.exists()
        if moved:
            if new_folder.exists():
                raise RuntimeError("Meeting folder already exists")
            old_folder.rename(new_folder)
        try:
            yield
        except BaseException:
            if moved and new_folder.exists():
                try:
                    new_folder.rename(old_folder)
                except OSError:
                    pass
            raise

    def delete(self, meeting: Mapping[Any, Any]) -> None:
        shutil.rmtree(self.folder(meeting), ignore_errors=True)
