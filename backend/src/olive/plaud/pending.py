"""When a Plaud recording that is still waiting on Plaud's processing gets ingested.

Plaud uploads audio before its own transcript and summary (PCS) exist, so a
discovered recording waits in ``plaud_ingest_state`` until either the content
shows up (ingest everything) or its deadline passes (ingest the audio only and
let Olive transcribe it). This module holds that rule as plain functions over
plain values; the poller loads the rows, calls Plaud, and persists the outcome.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class PendingDecision(StrEnum):
    #: Plaud's transcript or summary is available: ingest it with the audio.
    READY = "ready"
    #: The deadline passed with no Plaud content: ingest the audio only.
    EXPIRED = "expired"
    #: Plaud is still processing: check again later.
    WAIT = "wait"


@dataclass(frozen=True)
class PendingRecording:
    """An unresolved ``plaud_ingest_state`` row plus its meeting's status."""

    meeting_id: str
    plaud_file_id: str
    first_seen_at: int
    pcs_deadline_at: int
    meeting_status: str
    duplicate_of_meeting_id: str | None = None

    @classmethod
    def from_rows(cls, state: Mapping[Any, Any], meeting: Mapping[Any, Any]) -> PendingRecording:
        return cls(
            meeting_id=str(state["meeting_id"]),
            plaud_file_id=str(state["plaud_file_id"]),
            first_seen_at=int(state["first_seen_at"]),
            pcs_deadline_at=int(state["pcs_deadline_at"]),
            meeting_status=str(meeting.get("status") or ""),
            duplicate_of_meeting_id=state.get("duplicate_of_meeting_id") or None,
        )


def should_fetch(recording: PendingRecording, *, waiting_only: bool = False) -> bool:
    """Whether a poll pass should ask Plaud about this recording.

    Duplicates are never fetched again. The frequent pending pass
    (``waiting_only``) only looks at meetings still ``processing``: failed
    ones are left to the regular poll so a broken recording is not retried
    every minute.
    """
    if recording.duplicate_of_meeting_id:
        return False
    return not waiting_only or recording.meeting_status == "processing"


def is_waiting(recording: PendingRecording) -> bool:
    """Whether the recording keeps the frequent pending check armed."""
    return should_fetch(recording, waiting_only=True)


def content_is_ready(detail: Mapping[str, Any]) -> bool:
    return bool(detail.get("source_list") or detail.get("note_list"))


def deadline_expired(recording: PendingRecording, *, now: int, pcs_wait_ms: int) -> bool:
    return now >= recording.pcs_deadline_at or (now - recording.first_seen_at) >= pcs_wait_ms


def decide(
    recording: PendingRecording,
    detail: Mapping[str, Any],
    *,
    now: int,
    pcs_wait_ms: int,
) -> PendingDecision:
    """What to do with a pending recording given Plaud's current file detail."""
    if content_is_ready(detail):
        return PendingDecision.READY
    if deadline_expired(recording, now=now, pcs_wait_ms=pcs_wait_ms):
        return PendingDecision.EXPIRED
    return PendingDecision.WAIT
