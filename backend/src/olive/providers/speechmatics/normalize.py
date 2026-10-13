"""Speechmatics json-v2 normalizer (port of providers/speechmatics/normalize.ts)."""

from __future__ import annotations

from typing import Any

from ...schemas import Transcript, TranscriptSegment, TranscriptSpeakerInfo, TranscriptWord

TRAILING_PUNCTUATION = {".", ",", "!", "?", ":", ";", ")", "]", "}", "%", "...", "”", "’", "'"}
LEADING_PUNCTUATION = {"(", "[", "{", "“", "$", "£", "€", "#"}
MAX_GAP_SPLIT_MS = 3000


def _seconds_to_ms(seconds: float) -> int:
    return int(round(seconds * 1000))


def _normalize_speaker_label(speaker: str | None) -> str:
    if not speaker:
        return "Speaker"
    trimmed = speaker.strip()
    return trimmed or "Speaker"


def _finalize_segment(segment: dict[str, Any]) -> TranscriptSegment:
    tokens = segment["tokens"]
    text = ""
    for i, token in enumerate(tokens):
        if i == 0:
            text += token["text"]
        else:
            prev = tokens[i - 1]
            if token["isPunctuation"] and not token["isLeading"]:
                text += token["text"]
            elif prev["isLeading"]:
                text += token["text"]
            else:
                text += f" {token['text']}"

    words = segment["words"]
    return TranscriptSegment(
        startMs=segment["startMs"],
        endMs=segment["endMs"],
        speaker=segment["speaker"],
        text=text.strip(),
        words=words if words else None,
    )


def parse_speechmatics_json_v2(json_data: dict[str, Any]) -> Transcript:
    results = json_data.get("results") or []
    segments: list[TranscriptSegment] = []
    current_segment: dict[str, Any] | None = None

    for item in results:
        if not isinstance(item, dict):
            continue
        alts = item.get("alternatives") or []
        if not alts or not isinstance(alts[0], dict):
            continue
        alt = alts[0]
        content = alt.get("content")
        if not content:
            continue

        start_s = float(item.get("start_time") or 0.0)
        raw_end = item.get("end_time")
        end_s = float(raw_end if raw_end is not None else start_s)
        item_start_ms = _seconds_to_ms(start_s)
        item_end_ms = _seconds_to_ms(end_s)
        speaker = _normalize_speaker_label(alt.get("speaker"))
        item_type = item.get("type")

        if item_type == "word":
            should_split = (
                current_segment is None
                or current_segment["speaker"] != speaker
                or (
                    item_start_ms - current_segment["endMs"] > MAX_GAP_SPLIT_MS
                    and len(current_segment["words"]) > 0
                )
            )
            if should_split or current_segment is None:
                if current_segment is not None:
                    segments.append(_finalize_segment(current_segment))
                current_segment = {
                    "speaker": speaker,
                    "startMs": item_start_ms,
                    "endMs": item_end_ms,
                    "tokens": [{"text": str(content), "isPunctuation": False, "isLeading": False}],
                    "words": [
                        TranscriptWord(
                            startMs=item_start_ms,
                            endMs=item_end_ms,
                            word=str(content),
                            confidence=alt.get("confidence"),
                            speaker=speaker,
                        )
                    ],
                }
            else:
                current_segment["endMs"] = max(current_segment["endMs"], item_end_ms)
                current_segment["tokens"].append(
                    {"text": str(content), "isPunctuation": False, "isLeading": False}
                )
                current_segment["words"].append(
                    TranscriptWord(
                        startMs=item_start_ms,
                        endMs=item_end_ms,
                        word=str(content),
                        confidence=alt.get("confidence"),
                        speaker=speaker,
                    )
                )
        elif item_type == "punctuation":
            punct = str(content)
            is_leading = item.get("attaches_to") == "next" or (punct in LEADING_PUNCTUATION)
            if current_segment is not None:
                current_segment["endMs"] = max(current_segment["endMs"], item_end_ms)
                current_segment["tokens"].append(
                    {"text": punct, "isPunctuation": True, "isLeading": is_leading}
                )
            else:
                current_segment = {
                    "speaker": speaker,
                    "startMs": item_start_ms,
                    "endMs": item_end_ms,
                    "tokens": [{"text": punct, "isPunctuation": True, "isLeading": is_leading}],
                    "words": [],
                }

    if current_segment is not None:
        segments.append(_finalize_segment(current_segment))

    job_obj: dict[str, Any] = (
        json_data["job"] if isinstance(json_data.get("job"), dict) else {}
    )
    meta_obj: dict[str, Any] = (
        json_data["metadata"] if isinstance(json_data.get("metadata"), dict) else {}
    )
    tcfg: dict[str, Any] = (
        meta_obj["transcription_config"]
        if isinstance(meta_obj.get("transcription_config"), dict)
        else {}
    )

    duration_ms = (
        _seconds_to_ms(float(job_obj["duration"]))
        if job_obj.get("duration")
        else (segments[-1].endMs if segments else 0)
    )
    language = str(job_obj.get("lang") or tcfg.get("language") or "en")

    raw_speakers = json_data.get("speakers") or []
    speakers_out: list[TranscriptSpeakerInfo] = []
    for spk in raw_speakers:
        if isinstance(spk, dict):
            ids = spk.get("speaker_identifiers")
            speakers_out.append(
                TranscriptSpeakerInfo(
                    label=spk.get("label"),
                    speaker=spk.get("speaker"),
                    speaker_identifiers=list(ids) if ids is not None else None,
                )
            )

    return Transcript(
        segments=segments,
        language=language,
        durationMs=duration_ms,
        speakers=speakers_out,
    )


parseSpeechmaticsJsonV2 = parse_speechmatics_json_v2


def transcript_to_text(transcript: Transcript | dict[str, Any]) -> str:
    t = transcript if isinstance(transcript, Transcript) else Transcript.model_validate(transcript)
    if not t.segments:
        return ""
    return "\n\n".join(f"{seg.speaker}: {seg.text}" for seg in t.segments)


transcriptToText = transcript_to_text
