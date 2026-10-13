"""ML protocols and data structures (port of providers/local/types.ts)."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np

from ..schemas import Transcript, TranscriptWord

VoiceprintVector = list[float]


@dataclass
class LocalSpeakerSegment:
    startMs: int
    endMs: int
    speakerId: str
    samples: np.ndarray
    embedding: VoiceprintVector | None = None


@dataclass
class DiscoveredSpeakerVoiceprint:
    speakerId: str
    name: str
    voiceprint: VoiceprintVector
    isEnrolled: bool
    similarityScore: float | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "speakerId": self.speakerId,
            "name": self.name,
            "voiceprint": self.voiceprint,
            "isEnrolled": self.isEnrolled,
        }
        if self.similarityScore is not None:
            out["similarityScore"] = self.similarityScore
        return out


@dataclass
class LocalTranscriptionResult:
    transcript: Transcript
    discoveredSpeakers: list[DiscoveredSpeakerVoiceprint] = field(default_factory=list)


class SpeakerEmbedder(Protocol):
    @property
    def dim(self) -> int: ...

    async def extract(self, samples: np.ndarray, sample_rate: int = 16000) -> VoiceprintVector: ...

    def release(self) -> None: ...


SpeakerEmbeddingExtractorInterface = SpeakerEmbedder


class Diarizer(Protocol):
    async def diarize(
        self,
        samples: np.ndarray,
        sample_rate: int = 16000,
        clustering_threshold_override: float | None = None,
        expected_speaker_count: int | None = None,
    ) -> list[LocalSpeakerSegment]: ...

    def release(self) -> None: ...


DiarizerInterface = Diarizer


class AsrBackend(Protocol):
    async def transcribe_segment(
        self,
        samples: np.ndarray,
        sample_rate: int = 16000,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...

    def release(self) -> None: ...


LocalAsrEngineInterface = AsrBackend


class Aligner(Protocol):
    async def align(
        self,
        samples: np.ndarray,
        sample_rate: int,
        text: str,
        language: str = "en",
        offset_ms: int = 0,
    ) -> list[TranscriptWord]: ...

    def release(self) -> None: ...
