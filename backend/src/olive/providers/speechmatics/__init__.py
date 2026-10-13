"""Speechmatics batch provider package."""

from .client import SpeechmaticsClient
from .normalize import (
    parse_speechmatics_json_v2,
    parseSpeechmaticsJsonV2,
    transcript_to_text,
    transcriptToText,
)
from .types import (
    SpeechmaticsJobStatus,
    SpeechmaticsJsonV2,
    SpeechmaticsNotificationConfig,
    SpeechmaticsSpeakerConfig,
    SpeechmaticsSpeakerDiarizationConfig,
    SpeechmaticsTranscriptionConfig,
)

__all__ = [
    "SpeechmaticsClient",
    "SpeechmaticsJobStatus",
    "SpeechmaticsJsonV2",
    "SpeechmaticsNotificationConfig",
    "SpeechmaticsSpeakerConfig",
    "SpeechmaticsSpeakerDiarizationConfig",
    "SpeechmaticsTranscriptionConfig",
    "parseSpeechmaticsJsonV2",
    "parse_speechmatics_json_v2",
    "transcriptToText",
    "transcript_to_text",
]
