"""Muse response normalizer tests (no network)."""

from __future__ import annotations

from olive.providers.muse import (
    merge_muse_chunk_transcripts,
    parse_muse_transcript,
    shift_transcript_segments,
    transcript_to_text,
)
from olive.schemas import Transcript, TranscriptSegment


def _diarized() -> dict:
    return {
        "transcript": "Hello everyone. Hi there.",
        "audioDurationMs": 5000,
        "turns": [
            {"text": "Hello everyone.", "speaker": "A", "startMs": 100, "endMs": 1000, "turnId": 1},
            {"transcript": "Hi there.", "speaker": "B", "startMs": 2000, "endMs": 3000, "turnId": 2},
        ],
        "sessionId": "s-1",
    }


def test_diarized_turns_map_to_speaker_segments() -> None:
    out = parse_muse_transcript(_diarized())
    assert [(s.speaker, s.text, s.startMs, s.endMs) for s in out.segments] == [
        ("Speaker 1", "Hello everyone.", 100, 1000),
        ("Speaker 2", "Hi there.", 2000, 3000),
    ]
    assert out.durationMs == 5000
    assert [(i.label, i.speaker) for i in out.speakers or []] == [
        ("Speaker 1", "A"),
        ("Speaker 2", "B"),
    ]


def test_unknown_speaker_falls_back_to_plain_speaker() -> None:
    out = parse_muse_transcript(
        {
            "transcript": "Hello?",
            "audioDurationMs": 1000,
            "turns": [{"text": "Hello?", "speaker": "unknown", "startMs": 0, "endMs": 900}],
        }
    )
    assert out.segments[0].speaker == "Speaker"
    assert out.speakers is not None
    assert [(i.label, i.speaker) for i in out.speakers] == [("Speaker", "unknown")]


def test_push_to_talk_empty_turns_uses_full_transcript() -> None:
    out = parse_muse_transcript({"transcript": "Just one turn.", "audioDurationMs": 4000, "turns": []})
    assert len(out.segments) == 1
    assert out.segments[0].text == "Just one turn."
    assert out.segments[0].speaker == "Speaker"
    assert (out.segments[0].startMs, out.segments[0].endMs) == (0, 4000)


def test_empty_turns_are_skipped() -> None:
    out = parse_muse_transcript(
        {
            "transcript": "Kept.",
            "audioDurationMs": 2000,
            "turns": [
                {"text": "   ", "speaker": "A", "startMs": 0, "endMs": 500},
                {"text": "Kept.", "speaker": "A", "startMs": 600, "endMs": 1500},
            ],
        }
    )
    assert [s.text for s in out.segments] == ["Kept."]


def test_offset_ms_shifts_chunk_segments() -> None:
    out = parse_muse_transcript(_diarized(), offset_ms=540000)
    assert (out.segments[0].startMs, out.segments[0].endMs) == (540100, 541000)
    assert out.durationMs == 545000


def test_shift_transcript_segments_helper() -> None:
    base = Transcript(
        segments=[TranscriptSegment(startMs=10, endMs=20, speaker="Speaker 1", text="hi")],
        durationMs=20,
    )
    shifted = shift_transcript_segments(base, 1000)
    assert (shifted.segments[0].startMs, shifted.segments[0].endMs) == (1010, 1020)
    assert shifted.durationMs == 1020
    assert shift_transcript_segments(base, 0) is base


def test_merge_namespaces_request_scoped_labels_per_chunk() -> None:
    out = merge_muse_chunk_transcripts(
        [
            {
                "transcript": "Hello.",
                "audioDurationMs": 5000,
                "turns": [
                    {"text": "Hello.", "speaker": "A", "startMs": 100, "endMs": 1000},
                    {"text": "Anyone?", "speaker": "B", "startMs": 2000, "endMs": 3000},
                ],
            },
            {
                "transcript": "Hi.",
                "audioDurationMs": 4000,
                "turns": [
                    # Same letters, different request scope: new clusters.
                    {"text": "Hi.", "speaker": "A", "startMs": 200, "endMs": 1200},
                    {"text": "Yo.", "speaker": None, "startMs": 1500, "endMs": 2500},
                ],
            },
        ],
        [0, 5000],
    )
    assert [(s.speaker, s.startMs, s.endMs) for s in out.segments] == [
        ("Speaker 1", 100, 1000),
        ("Speaker 2", 2000, 3000),
        ("Speaker 3", 5200, 6200),
        ("Speaker 4", 6500, 7500),
    ]
    assert [(i.label, i.speaker) for i in out.speakers or []] == [
        ("Speaker 1", "A"),
        ("Speaker 2", "B"),
        ("Speaker 3", "A"),
        ("Speaker 4", None),
    ]
    assert out.durationMs == 9000


def test_merge_falls_back_to_full_transcript_without_turns() -> None:
    out = merge_muse_chunk_transcripts(
        [{"transcript": "Just one turn.", "audioDurationMs": 4000, "turns": []}],
        [1000],
    )
    assert [(s.speaker, s.text, s.startMs) for s in out.segments] == [("Speaker 1", "Just one turn.", 1000)]


def test_transcript_to_text() -> None:
    assert transcript_to_text(parse_muse_transcript(_diarized())) == (
        "Speaker 1: Hello everyone.\n\nSpeaker 2: Hi there."
    )


def test_camel_case_alias_works() -> None:
    from olive.providers.muse import parseMuseTranscript, transcriptToText

    out = parseMuseTranscript(_diarized())
    assert len(out.segments) == 2
    assert "Speaker 1:" in transcriptToText(out)
