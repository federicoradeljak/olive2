"""Plaud pending rule: when a recording waiting on Plaud gets ingested."""

from __future__ import annotations

from typing import Any

import pytest

from olive.plaud.pending import (
    PendingDecision,
    PendingRecording,
    decide,
    is_waiting,
    should_fetch,
)

WAIT_MS = 1_000


def _recording(**overrides: Any) -> PendingRecording:
    values: dict[str, Any] = {
        "meeting_id": "m1",
        "plaud_file_id": "of_abc",
        "first_seen_at": 10_000,
        "pcs_deadline_at": 10_000 + WAIT_MS,
        "meeting_status": "processing",
    }
    return PendingRecording(**{**values, **overrides})


@pytest.mark.parametrize(
    ("detail", "now", "expected"),
    [
        ({"source_list": [{"data_type": "transcript"}]}, 10_000, PendingDecision.READY),
        ({"note_list": [{"data_type": "summary"}]}, 10_000, PendingDecision.READY),
        # Content wins over an expired deadline: Plaud's transcript is kept.
        ({"source_list": [{"data_type": "transcript"}]}, 99_000, PendingDecision.READY),
        ({"source_list": [], "note_list": []}, 10_999, PendingDecision.WAIT),
        ({"source_list": [], "note_list": []}, 11_000, PendingDecision.EXPIRED),
        ({}, 11_000, PendingDecision.EXPIRED),
    ],
)
def test_decide(detail: dict[str, Any], now: int, expected: PendingDecision) -> None:
    assert decide(_recording(), detail, now=now, pcs_wait_ms=WAIT_MS) is expected


def test_wait_since_first_seen_expires_even_with_a_later_stored_deadline() -> None:
    recording = _recording(pcs_deadline_at=50_000)

    assert decide(recording, {}, now=10_999, pcs_wait_ms=WAIT_MS) is PendingDecision.WAIT
    assert decide(recording, {}, now=11_000, pcs_wait_ms=WAIT_MS) is PendingDecision.EXPIRED


def test_stored_deadline_expires_before_the_configured_wait() -> None:
    recording = _recording(pcs_deadline_at=10_500)

    assert decide(recording, {}, now=10_500, pcs_wait_ms=WAIT_MS) is PendingDecision.EXPIRED


def test_duplicates_are_never_fetched_or_waited_on() -> None:
    duplicate = _recording(duplicate_of_meeting_id="m0")

    assert not should_fetch(duplicate)
    assert not should_fetch(duplicate, waiting_only=True)
    assert not is_waiting(duplicate)


@pytest.mark.parametrize("status", ["error", "ready", "pending"])
def test_pending_pass_leaves_non_processing_meetings_to_the_full_poll(status: str) -> None:
    recording = _recording(meeting_status=status)

    assert should_fetch(recording)
    assert not should_fetch(recording, waiting_only=True)
    assert not is_waiting(recording)


def test_processing_meeting_is_waiting() -> None:
    recording = _recording()

    assert should_fetch(recording, waiting_only=True)
    assert is_waiting(recording)


def test_from_rows_reads_state_and_meeting_status() -> None:
    recording = PendingRecording.from_rows(
        {
            "meeting_id": "m1",
            "plaud_file_id": "of_abc",
            "first_seen_at": 10_000,
            "pcs_deadline_at": 11_000,
            "pcs_resolved": 0,
            "duplicate_of_meeting_id": None,
        },
        {"id": "m1", "status": "processing"},
    )

    assert recording == _recording()
