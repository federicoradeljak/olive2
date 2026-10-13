"""Meeting folder layout utilities (port of packages/server/src/layout.ts)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

UNSAFE_CHARS = re.compile(r'[/\\:*?"<>|\r\n\t]')
WHITESPACE_RUN = re.compile(r"\s+")
SINGLE_SPACE = re.compile(r"\s")
UNDERSCORE_RUN = re.compile(r"_+")
LEADING_TRAILING_DOT_UNDERSCORE = re.compile(r"^[._]+|[._]+$")


def sanitize_filename(name: str) -> str:
    s = UNSAFE_CHARS.sub("_", name)
    s = WHITESPACE_RUN.sub(" ", s).strip()
    s = SINGLE_SPACE.sub("_", s)
    s = UNDERSCORE_RUN.sub("_", s)
    s = LEADING_TRAILING_DOT_UNDERSCORE.sub("", s)
    return s[:100]


def date_stamp(start_time_ms: int) -> str:
    dt = datetime.fromtimestamp(start_time_ms / 1000.0, tz=UTC)
    return f"{dt.year}-{dt.month:02d}-{dt.day:02d}"


def meeting_folder_name(start_time_ms: int, title: str, meeting_id: str) -> str:
    safe_title = sanitize_filename(title) or "meeting"
    return f"{date_stamp(start_time_ms)}_{safe_title}__{meeting_id[:8]}"


@dataclass(frozen=True)
class MeetingPaths:
    folder: str
    audio_dir: str
    transcripts_dir: str
    summaries_dir: str

    @property
    def audioDir(self) -> str:
        return self.audio_dir

    @property
    def transcriptsDir(self) -> str:
        return self.transcripts_dir

    @property
    def summariesDir(self) -> str:
        return self.summaries_dir


def meeting_paths(meetings_dir: str | Path, start_time_ms: int, title: str, meeting_id: str) -> MeetingPaths:
    folder = Path(meetings_dir) / meeting_folder_name(start_time_ms, title, meeting_id)
    return MeetingPaths(
        folder=str(folder),
        audio_dir=str(folder / "audio"),
        transcripts_dir=str(folder / "transcripts"),
        summaries_dir=str(folder / "summaries"),
    )


def ensure_meeting_folder(paths: MeetingPaths) -> MeetingPaths:
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)
    Path(paths.summaries_dir).mkdir(parents=True, exist_ok=True)
    return paths
