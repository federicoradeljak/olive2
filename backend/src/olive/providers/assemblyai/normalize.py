"""AssemblyAI transcript normalizer (maps REST v2 transcript dicts to the canonical Transcript)."""

from __future__ import annotations

from typing import Any

from ...schemas import Transcript, TranscriptSegment, TranscriptSpeakerInfo, TranscriptWord
from .types import AssemblyAITranscript

MAX_GAP_SPLIT_MS = 3000


def _ms(value: Any) -> int:
    return int(round(float(value or 0)))


def _normalize_speaker_label(speaker: str | None) -> str:
    raw = (speaker or "").strip()
    if not raw:
        return "Speaker"
    if len(raw) == 1 and raw.upper() in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        return f"Speaker {ord(raw.upper()) - ord('A') + 1}"
    return f"Speaker {raw}"


def _words_from(raw_words: Any, fallback_speaker: str | None = None) -> list[TranscriptWord]:
    words: list[TranscriptWord] = []
    for w in raw_words or []:
        if not isinstance(w, dict):
            continue
        text = str(w.get("text") or "").strip()
        if not text:
            continue
        words.append(
            TranscriptWord(
                startMs=_ms(w.get("start")),
                endMs=_ms(w.get("end")),
                word=text,
                confidence=w.get("confidence"),
                speaker=_normalize_speaker_label(w.get("speaker") or fallback_speaker),
            )
        )
    return words


def _segments_from_utterances(
    utterances: list[dict[str, Any]],
) -> tuple[list[TranscriptSegment], list[str | None]]:
    segments: list[TranscriptSegment] = []
    raw_speakers: list[str | None] = []
    for u in utterances:
        text = str(u.get("text") or "").strip()
        if not text:
            continue
        raw_speaker = u.get("speaker")
        raw_speakers.append(raw_speaker)
        speaker = _normalize_speaker_label(raw_speaker)
        words = _words_from(u.get("words"), fallback_speaker=raw_speaker)
        segments.append(
            TranscriptSegment(
                startMs=_ms(u.get("start")),
                endMs=_ms(u.get("end")),
                speaker=speaker,
                text=text,
                words=words or None,
            )
        )
    return segments, raw_speakers


def _segments_from_words(
    words: list[TranscriptWord], raw_speakers: list[str | None]
) -> list[TranscriptSegment]:
    groups: list[list[TranscriptWord]] = []
    for w in words:
        current = groups[-1] if groups else None
        if (
            current is None
            or current[-1].speaker != w.speaker
            or w.startMs - current[-1].endMs > MAX_GAP_SPLIT_MS
        ):
            groups.append([w])
        else:
            current.append(w)

    segments: list[TranscriptSegment] = []
    for group in groups:
        segments.append(
            TranscriptSegment(
                startMs=group[0].startMs,
                endMs=max(w.endMs for w in group),
                speaker=group[0].speaker or "Speaker",
                text=" ".join(w.word for w in group),
                words=group,
            )
        )
    return segments


def parse_assemblyai_transcript(data: AssemblyAITranscript | dict[str, Any]) -> Transcript:
    raw_utterances: list[dict[str, Any]] = [
        dict(u) for u in (data.get("utterances") or []) if isinstance(u, dict)
    ]

    if raw_utterances:
        segments, raw_speakers = _segments_from_utterances(raw_utterances)
    else:
        words = _words_from(data.get("words"))
        raw_speakers = [w.get("speaker") for w in (data.get("words") or []) if isinstance(w, dict)]
        segments = _segments_from_words(words, raw_speakers)

    audio_duration = data.get("audio_duration")
    duration_ms = (
        _ms(float(audio_duration) * 1000) if audio_duration else (segments[-1].endMs if segments else 0)
    )

    speakers: list[TranscriptSpeakerInfo] = []
    seen: set[str] = set()
    for raw in raw_speakers:
        if not raw or raw in seen:
            continue
        seen.add(raw)
        speakers.append(TranscriptSpeakerInfo(label=_normalize_speaker_label(raw), speaker=raw))

    language_code = data.get("language_code")
    return Transcript(
        segments=segments,
        language=str(language_code) if language_code else None,
        durationMs=duration_ms,
        speakers=speakers,
    )


parseAssemblyAiTranscript = parse_assemblyai_transcript


def transcript_to_text(transcript: Transcript | dict[str, Any]) -> str:
    t = transcript if isinstance(transcript, Transcript) else Transcript.model_validate(transcript)
    if not t.segments:
        return ""
    return "\n\n".join(f"{seg.speaker}: {seg.text}" for seg in t.segments)


transcriptToText = transcript_to_text
