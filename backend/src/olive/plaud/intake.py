"""Store a Plaud recording's audio once: reuse, dedupe by hash, or write it."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..layout import MeetingPaths, ensure_meeting_folder, meeting_paths

PLAUD_PROVIDER = "plaud"


class DuplicateAudioError(Exception):
    def __init__(self, duplicate_of_meeting_id: str) -> None:
        super().__init__(f"Audio hash already belongs to meeting {duplicate_of_meeting_id}")
        self.duplicateOfMeetingId = duplicate_of_meeting_id
        self.duplicate_of_meeting_id = duplicate_of_meeting_id


@dataclass(frozen=True)
class DownloadedAudio:
    bytes: bytes
    extension: str
    mime: str
    sha256: str


@dataclass(frozen=True)
class StoredRecording:
    id: str
    #: Path relative to the meeting folder.
    path: str


class RecordingIntake:
    """Owns the ``recordings`` row and audio file of a Plaud meeting."""

    def __init__(self, db: Engine, meetings_dir: str, now: Callable[[], int]) -> None:
        self.db = db
        self.meetings_dir = meetings_dir
        self.now = now

    async def ensure(
        self,
        meeting: Mapping[Any, Any],
        plaud_file_id: str,
        duration_ms: int,
        download: Callable[[], Awaitable[DownloadedAudio]],
    ) -> StoredRecording:
        """Return the meeting's recording, downloading the audio only when needed.

        An existing recording whose file is still on disk is returned as is.
        Otherwise the audio is downloaded and matched by SHA-256: audio that
        already belongs to another meeting raises ``DuplicateAudioError``;
        audio already recorded for this meeting is relinked to the Plaud file
        and its missing file restored; anything else is written as a new (or
        refreshed) recording.
        """
        with self.db.connect() as conn:
            existing = (
                conn.execute(
                    text(
                        "SELECT id, path FROM recordings "
                        "WHERE provider = :prov AND provider_recording_id = :fid LIMIT 1"
                    ),
                    {"prov": PLAUD_PROVIDER, "fid": plaud_file_id},
                )
                .mappings()
                .first()
            )

        folder = Path(self._paths(meeting).folder)
        if existing and (folder / existing["path"]).exists():
            return StoredRecording(id=existing["id"], path=existing["path"])

        downloaded = await download()

        with self.db.connect() as conn:
            existing_by_hash = (
                conn.execute(
                    text("SELECT id, meeting_id, path FROM recordings WHERE sha256 = :sha LIMIT 1"),
                    {"sha": downloaded.sha256},
                )
                .mappings()
                .first()
            )

        if existing_by_hash:
            if existing_by_hash["meeting_id"] != meeting["id"]:
                raise DuplicateAudioError(existing_by_hash["meeting_id"])

            if not existing:
                with self.db.begin() as conn:
                    conn.execute(
                        text("UPDATE recordings SET provider_recording_id = :fid WHERE id = :id"),
                        {"fid": plaud_file_id, "id": existing_by_hash["id"]},
                    )
            abs_path = folder / existing_by_hash["path"]
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            if not abs_path.exists():
                abs_path.write_bytes(downloaded.bytes)
            return StoredRecording(id=existing_by_hash["id"], path=existing_by_hash["path"])

        rec_id = existing["id"] if existing else str(uuid.uuid4())
        rel_path = f"audio/{rec_id}.{downloaded.extension}"
        paths = ensure_meeting_folder(self._paths(meeting))
        (Path(paths.folder) / rel_path).write_bytes(downloaded.bytes)

        with self.db.begin() as conn:
            if existing:
                conn.execute(
                    text(
                        """
                        UPDATE recordings
                        SET path = :path, mime = :mime, duration_ms = :dur,
                            size_bytes = :sz, sha256 = :sha
                        WHERE id = :id
                        """
                    ),
                    {
                        "path": rel_path,
                        "mime": downloaded.mime,
                        "dur": duration_ms,
                        "sz": len(downloaded.bytes),
                        "sha": downloaded.sha256,
                        "id": existing["id"],
                    },
                )
                return StoredRecording(id=existing["id"], path=rel_path)

            conn.execute(
                text(
                    """
                    INSERT INTO recordings (
                      id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                      provider, provider_recording_id, created_at
                    ) VALUES (
                      :id, :mid, :path, :mime, :dur, :sz, :sha,
                      'plaud', :fid, :now
                    )
                    """
                ),
                {
                    "id": rec_id,
                    "mid": meeting["id"],
                    "path": rel_path,
                    "mime": downloaded.mime,
                    "dur": duration_ms,
                    "sz": len(downloaded.bytes),
                    "sha": downloaded.sha256,
                    "fid": plaud_file_id,
                    "now": self.now(),
                },
            )

        return StoredRecording(id=rec_id, path=rel_path)

    def _paths(self, meeting: Mapping[Any, Any]) -> MeetingPaths:
        return meeting_paths(self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"])
