"""Olive database package."""

from .migrations import DEFAULT_TEMPLATES, run_migrations
from .models import (
    ArtifactModel,
    Base,
    ChatMessageModel,
    LogModel,
    MeetingModel,
    MeetingSpeakerModel,
    PlaudIngestStateModel,
    RecordingModel,
    SpeakerModel,
    StageRunModel,
    SyncStateModel,
    TemplateModel,
)
from .session import (
    DbHandle,
    close_db,
    create_db,
    get_db,
    get_db_handle,
    reset_db_handle,
    set_db_for_tests,
)

__all__ = [
    "ArtifactModel",
    "Base",
    "ChatMessageModel",
    "DEFAULT_TEMPLATES",
    "DbHandle",
    "LogModel",
    "MeetingModel",
    "MeetingSpeakerModel",
    "PlaudIngestStateModel",
    "RecordingModel",
    "SpeakerModel",
    "StageRunModel",
    "SyncStateModel",
    "TemplateModel",
    "close_db",
    "create_db",
    "get_db",
    "get_db_handle",
    "reset_db_handle",
    "run_migrations",
    "set_db_for_tests",
]
