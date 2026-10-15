"""Muse Voice Transcribe response normalizer (maps transcribe JSON to canonical Transcript).

Muse returns turn-level timing with optional speaker labels (DIARIZATION) but
no word-level timestamps or confidence scores. Turn ``startMs``/``endMs`` are
processing-progress markers, not precise acoustic boundaries — good enough for
Olive's segment model, never for word alignment.
"""

from __future__ import annotations

from typing import Any

from ...schemas import Transcript, TranscriptSegment, TranscriptSpeakerInfo
from .types import MuseTranscribeResponse


def _ms(value: Any) -> int:
    try:
        return int(round(float(value or 0)))
    except (TypeError, ValueError):
        return 0


def _normalize_speaker_label(speaker: Any) -> str:
    raw = str(speaker or "").strip()
    if not raw or raw.lower() == "unknown":
        return "Speaker"
    if len(raw) == 1 and raw.upper() in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        return f"Speaker {ord(raw.upper()) - ord('A') + 1}"
    if raw.lower().startswith("speaker"):
        return raw
    return f"Speaker {raw}"


def parse_muse_transcript(
    data: MuseTranscribeResponse | dict[str, Any],
    *,
    offset_ms: int = 0,
) -> Transcript:
    """Maps a Muse transcribe JSON response to the canonical Transcript.

    ``offset_ms`` shifts every segment (chunked uploads: chunk base offset).
    Falls back to a single segment from the top-level ``transcript`` when
    ``turns`` is empty (PUSH_TO_TALK mode).
    """
    raw_turns = data.get("turns") or []
    segments: list[TranscriptSegment] = []
    raw_speakers: list[str | None] = []
    for turn in raw_turns:
        if not isinstance(turn, dict):
            continue
        text = str(turn.get("text") or turn.get("transcript") or "").strip()
        if not text:
            continue
        raw_speaker = turn.get("speaker")
        raw_speakers.append(raw_speaker if isinstance(raw_speaker, str) else None)
        segments.append(
            TranscriptSegment(
                startMs=_ms(turn.get("startMs")) + offset_ms,
                endMs=_ms(turn.get("endMs")) + offset_ms,
                speaker=_normalize_speaker_label(raw_speaker),
                text=text,
            )
        )

    duration_ms = _ms(data.get("audioDurationMs")) + offset_ms
    if not segments:
        text = str(data.get("transcript") or "").strip()
        if text:
            segments.append(
                TranscriptSegment(
                    startMs=offset_ms,
                    endMs=max(offset_ms, duration_ms),
                    speaker="Speaker",
                    text=text,
                )
            )
        else:
            duration_ms = offset_ms

    speakers: list[TranscriptSpeakerInfo] = []
    seen: set[str] = set()
    for raw in raw_speakers:
        if not raw or raw in seen:
            continue
        seen.add(raw)
        speakers.append(TranscriptSpeakerInfo(label=_normalize_speaker_label(raw), speaker=raw))

    if not duration_ms and segments:
        duration_ms = segments[-1].endMs

    return Transcript(
        segments=segments,
        language=None,
        durationMs=duration_ms,
        speakers=speakers,
    )


parseMuseTranscript = parse_muse_transcript


def merge_muse_chunk_transcripts(
    responses: list[MuseTranscribeResponse | dict[str, Any]],
    offsets_ms: list[int] | None = None,
) -> Transcript:
    """Merges per-chunk Muse responses into one Transcript with globally unique speakers.

    Muse speaker labels are scoped to a single request: chunk 0's ``A`` and
    chunk 1's ``A`` may be different people. Merging them into one label
    would average two voices into a single re-identification centroid and
    rename both chunks' segments to the same name. Instead, every
    ``(chunk, raw_label)`` pair gets its own ``Speaker N`` in order of first
    appearance, and the existing voiceprint matcher reconciles same-person
    clusters back to one enrolled name.
    """
    offsets = list(offsets_ms) if offsets_ms else [0] * len(responses)
    segments: list[TranscriptSegment] = []
    global_index: dict[tuple[int, str], int] = {}
    raw_by_index: dict[int, str | None] = {}
    total_duration_ms = 0
    for chunk_idx, raw in enumerate(responses):
        offset = offsets[chunk_idx] if chunk_idx < len(offsets) else 0
        raw_turns = [t for t in (raw.get("turns") or []) if isinstance(t, dict)]
        if not raw_turns and str(raw.get("transcript") or "").strip():
            raw_turns = [{"transcript": raw.get("transcript")}]
        for turn in raw_turns:
            text = str(turn.get("text") or turn.get("transcript") or "").strip()
            if not text:
                continue
            raw_label = turn.get("speaker")
            key = (chunk_idx, str(raw_label).strip() if isinstance(raw_label, str) else "")
            if key not in global_index:
                global_index[key] = len(global_index) + 1
                raw_by_index[global_index[key]] = raw_label if isinstance(raw_label, str) else None
            number = global_index[key]
            segments.append(
                TranscriptSegment(
                    startMs=_ms(turn.get("startMs")) + offset,
                    endMs=_ms(turn.get("endMs")) + offset,
                    speaker=f"Speaker {number}",
                    text=text,
                )
            )
        total_duration_ms = max(total_duration_ms, _ms(raw.get("audioDurationMs")) + offset)

    speakers = [
        TranscriptSpeakerInfo(label=f"Speaker {n}", speaker=raw_by_index[n]) for n in sorted(raw_by_index)
    ]
    if not total_duration_ms and segments:
        total_duration_ms = segments[-1].endMs
    return Transcript(
        segments=segments,
        language=None,
        durationMs=total_duration_ms,
        speakers=speakers,
    )


mergeMuseChunkTranscripts = merge_muse_chunk_transcripts


def shift_transcript_segments(transcript: Transcript, offset_ms: int) -> Transcript:
    """Returns a copy of ``transcript`` with every segment shifted by ``offset_ms``."""
    if not offset_ms:
        return transcript
    return Transcript(
        segments=[
            TranscriptSegment(
                startMs=seg.startMs + offset_ms,
                endMs=seg.endMs + offset_ms,
                speaker=seg.speaker,
                text=seg.text,
                verified=seg.verified,
                words=seg.words,
            )
            for seg in transcript.segments
        ],
        language=transcript.language,
        durationMs=(transcript.durationMs or 0) + offset_ms,
        speakers=transcript.speakers,
    )


shiftTranscriptSegments = shift_transcript_segments


def transcript_to_text(transcript: Transcript | dict[str, Any]) -> str:
    t = transcript if isinstance(transcript, Transcript) else Transcript.model_validate(transcript)
    if not t.segments:
        return ""
    return "\n\n".join(f"{seg.speaker}: {seg.text}" for seg in t.segments)


transcriptToText = transcript_to_text
