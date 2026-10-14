"""AssemblyAI normalizer tests."""

from __future__ import annotations

from olive.providers.assemblyai import parse_assemblyai_transcript, transcript_to_text


def _w(text: str, start: int, end: int, speaker: str | None = None) -> dict:
    return {"text": text, "start": start, "end": end, "confidence": 0.95, "speaker": speaker, "channel": None}


def test_utterances_path_maps_speakers_and_ms_timings() -> None:
    data = {
        "id": "t1",
        "status": "completed",
        "language_code": "en_us",
        "audio_duration": 7.5,
        "words": [],
        "utterances": [
            {
                "text": "Hello there.",
                "start": 0,
                "end": 1500,
                "confidence": 0.9,
                "speaker": "A",
                "words": [_w("Hello", 0, 700, "A"), _w("there.", 800, 1500, "A")],
            },
            {
                "text": "Hi, how are you?",
                "start": 1800,
                "end": 3600,
                "confidence": 0.9,
                "speaker": "B",
                "words": [_w("Hi,", 1800, 2000, "B"), _w("how", 2100, 2400, "B"), _w("are you?", 2500, 3600, "B")],
            },
        ],
    }
    t = parse_assemblyai_transcript(data)

    assert t.language == "en_us"
    assert t.durationMs == 7500
    assert [s.speaker for s in t.segments] == ["Speaker 1", "Speaker 2"]
    assert t.segments[0].startMs == 0
    assert t.segments[0].endMs == 1500
    assert t.segments[1].startMs == 1800
    assert t.segments[1].text == "Hi, how are you?"
    assert t.segments[0].words is not None
    assert [w.word for w in t.segments[0].words] == ["Hello", "there."]
    assert t.segments[0].words[1].startMs == 800
    assert t.segments[1].words[0].speaker == "Speaker 2"
    assert [(s.label, s.speaker) for s in t.speakers] == [("Speaker 1", "A"), ("Speaker 2", "B")]


def test_words_fallback_groups_by_speaker_and_gap() -> None:
    data = {
        "language_code": "en",
        "audio_duration": 10,
        "words": [
            _w("Hello", 0, 500, "A"),
            _w("world.", 600, 1100, "A"),
            _w("Yes.", 1200, 1600, "B"),
            # same speaker, but gap > 3000ms splits
            _w("Later", 5000, 5400, "B"),
            _w("again", 5500, 5900, "B"),
        ],
    }
    t = parse_assemblyai_transcript(data)

    assert [s.speaker for s in t.segments] == ["Speaker 1", "Speaker 2", "Speaker 2"]
    assert t.segments[0].text == "Hello world."
    assert t.segments[0].startMs == 0
    assert t.segments[0].endMs == 1100
    assert t.segments[1].text == "Yes."
    assert t.segments[2].text == "Later again"
    assert t.segments[2].startMs == 5000
    assert t.durationMs == 10000
    assert [s.speaker for s in t.speakers or []] == ["A", "B"]


def test_empty_transcript_and_empty_text_skipped() -> None:
    t = parse_assemblyai_transcript({"status": "completed", "words": [], "utterances": []})
    assert t.segments == []
    assert t.durationMs == 0
    assert t.speakers == []
    assert transcript_to_text(t) == ""

    t2 = parse_assemblyai_transcript(
        {
            "utterances": [
                {"text": "   ", "start": 0, "end": 100, "speaker": "A", "words": []},
                {"text": "Real.", "start": 100, "end": 900, "speaker": "A", "words": []},
            ],
        }
    )
    assert len(t2.segments) == 1
    assert t2.segments[0].text == "Real."
    assert t2.durationMs == 900


def test_transcript_to_text_joins_speaker_turns() -> None:
    t = parse_assemblyai_transcript(
        {
            "utterances": [
                {"text": "One.", "start": 0, "end": 500, "speaker": "A", "words": []},
                {"text": "Two.", "start": 600, "end": 900, "speaker": "B", "words": []},
            ],
        }
    )
    assert transcript_to_text(t) == "Speaker 1: One.\n\nSpeaker 2: Two."
