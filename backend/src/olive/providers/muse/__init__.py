"""Muse Voice Transcribe provider package."""

from .audio import MUSE_MAX_CHUNK_MS, MUSE_SAMPLE_RATE, prepare_muse_wav_chunks
from .client import DEFAULT_BASE_URL, DEFAULT_MODEL, DIARIZATION_MODE, MuseClient
from .normalize import (
    merge_muse_chunk_transcripts,
    mergeMuseChunkTranscripts,
    parse_muse_transcript,
    parseMuseTranscript,
    shift_transcript_segments,
    shiftTranscriptSegments,
    transcript_to_text,
    transcriptToText,
)
from .types import MuseTranscribeResponse, MuseTurn

__all__ = [
    "DEFAULT_BASE_URL",
    "DEFAULT_MODEL",
    "DIARIZATION_MODE",
    "MUSE_MAX_CHUNK_MS",
    "MUSE_SAMPLE_RATE",
    "MuseClient",
    "MuseTranscribeResponse",
    "MuseTurn",
    "mergeMuseChunkTranscripts",
    "merge_muse_chunk_transcripts",
    "parseMuseTranscript",
    "parse_muse_transcript",
    "prepare_muse_wav_chunks",
    "shiftTranscriptSegments",
    "shift_transcript_segments",
    "transcriptToText",
    "transcript_to_text",
]
