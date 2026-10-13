"""Speechmatics batch provider types (port of providers/speechmatics/types.ts)."""

from __future__ import annotations

from typing import Any, Literal, TypedDict


class SpeechmaticsSpeakerConfig(TypedDict, total=False):
    label: str
    speaker_identifiers: list[str]


class SpeechmaticsSpeakerDiarizationConfig(TypedDict, total=False):
    speakers: list[SpeechmaticsSpeakerConfig]
    get_speakers: bool


class SpeechmaticsTranscriptionConfig(TypedDict, total=False):
    language: str
    diarization: Literal["speaker", "channel", "none"]
    speaker_diarization_config: SpeechmaticsSpeakerDiarizationConfig
    additional_vocab: list[dict[str, Any]]


class SpeechmaticsNotificationConfig(TypedDict, total=False):
    url: str
    contents: list[Literal["transcript", "data"]]
    auth_headers: list[str]


class SpeechmaticsJobStatus(TypedDict, total=False):
    id: str
    status: Literal["running", "done", "rejected", "deleted"]
    created_at: str
    data_name: str | None
    duration: float | None
    errors: list[dict[str, str]] | None


SpeechmaticsJsonV2 = dict[str, Any]
