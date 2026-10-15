"""Muse Voice Transcribe provider types (POST /v1/asr/transcribe shapes)."""

from __future__ import annotations

from typing import TypedDict


class MuseTurn(TypedDict, total=False):
    text: str
    transcript: str
    speaker: str | None
    startMs: int
    endMs: int
    turnId: int


class MuseTranscribeResponse(TypedDict, total=False):
    transcript: str
    audioDurationMs: int
    turns: list[MuseTurn]
    sessionId: str
