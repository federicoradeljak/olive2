"""AssemblyAI batch provider types (REST v2 transcript payload shapes)."""

from __future__ import annotations

from typing import Any, TypedDict


class AssemblyAIWord(TypedDict, total=False):
    text: str
    start: int
    end: int
    confidence: float
    speaker: str | None
    channel: str | None


class AssemblyAIUtterance(TypedDict, total=False):
    text: str
    start: int
    end: int
    confidence: float
    speaker: str
    words: list[AssemblyAIWord]


class AssemblyAITranscript(TypedDict, total=False):
    id: str
    status: str
    text: str | None
    language_code: str | None
    audio_duration: float | None
    error: str | None
    words: list[AssemblyAIWord]
    utterances: list[AssemblyAIUtterance]
    json_response: dict[str, Any] | None
