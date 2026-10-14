"""Shared classification of generic (unidentified) speaker labels.

Diarization / cloud ASR produce placeholder labels such as ``Speaker 1``,
``S1``, ``SPEAKER_00`` or ``Unknown`` for clusters that have not been matched
to an enrolled person. Those labels are fine to display in a transcript, but
an unidentified cluster is not a person: it must never be persisted as a
``speakers`` row, linked via ``meeting_speakers``, or offered as a match
target in the People screen / assignment modal.
"""

from __future__ import annotations

import re

_GENERIC_SPEAKER_RE = re.compile(
    r"^(?:"
    r"(?:speaker|speakers)(?:[\s_-]*#?(?:\d+|[a-z]{1,2}))?"
    r"|(?:spk|participant|person|guest|unknown|uu)(?:[\s_-]*#?\d+)?"
    r"|unknown[\s_-]+speaker(?:[\s_-]*#?\d+)?"
    r"|s[\s_-]*\d+"
    r")$",
    re.IGNORECASE,
)


def is_generic_speaker_label(name: str | None) -> bool:
    """Return True for placeholder labels (incl. empty) that are not people."""
    if not name or not name.strip():
        return True
    return bool(_GENERIC_SPEAKER_RE.match(name.strip()))


__all__ = ["is_generic_speaker_label"]
