"""Speechmatics json-v2 normalizer tests (port of speechmatics-normalize.test.ts)."""

from __future__ import annotations

from olive.providers.speechmatics import parse_speechmatics_json_v2, transcript_to_text


def test_normalizes_words_punctuation_and_multiple_speakers_into_canonical_segments() -> None:
    fixture = {
        "format": "2.0",
        "job": {"id": "job-123", "duration": 10.5, "lang": "en"},
        "results": [
            {
                "type": "word",
                "start_time": 0.5,
                "end_time": 0.9,
                "alternatives": [{"content": "Hello", "confidence": 0.99, "speaker": "Alice"}],
            },
            {
                "type": "punctuation",
                "start_time": 0.9,
                "end_time": 0.9,
                "alternatives": [{"content": ",", "confidence": 1.0, "speaker": "Alice"}],
            },
            {
                "type": "word",
                "start_time": 1.0,
                "end_time": 1.5,
                "alternatives": [{"content": "everyone", "confidence": 0.95, "speaker": "Alice"}],
            },
            {
                "type": "punctuation",
                "start_time": 1.5,
                "end_time": 1.5,
                "alternatives": [{"content": ".", "confidence": 1.0, "speaker": "Alice"}],
            },
            {
                "type": "word",
                "start_time": 2.0,
                "end_time": 2.4,
                "alternatives": [{"content": "Hi", "confidence": 0.92, "speaker": "Bob"}],
            },
            {
                "type": "word",
                "start_time": 2.5,
                "end_time": 3.0,
                "alternatives": [{"content": "Alice", "confidence": 0.96, "speaker": "Bob"}],
            },
            {
                "type": "punctuation",
                "start_time": 3.0,
                "end_time": 3.0,
                "alternatives": [{"content": "!", "confidence": 1.0, "speaker": "Bob"}],
            },
        ],
        "speakers": [
            {"speaker": "Alice", "speaker_identifiers": ["voice-alice-1"]},
            {"speaker": "Bob", "speaker_identifiers": ["voice-bob-1"]},
        ],
    }

    transcript = parse_speechmatics_json_v2(fixture)
    assert transcript.language == "en"
    assert transcript.durationMs == 10500
    assert len(transcript.segments) == 2

    assert transcript.segments[0].model_dump(exclude_none=True) == {
        "startMs": 500,
        "endMs": 1500,
        "speaker": "Alice",
        "text": "Hello, everyone.",
        "words": [
            {"startMs": 500, "endMs": 900, "word": "Hello", "confidence": 0.99, "speaker": "Alice"},
            {
                "startMs": 1000,
                "endMs": 1500,
                "word": "everyone",
                "confidence": 0.95,
                "speaker": "Alice",
            },
        ],
    }

    assert transcript.segments[1].model_dump(exclude_none=True) == {
        "startMs": 2000,
        "endMs": 3000,
        "speaker": "Bob",
        "text": "Hi Alice!",
        "words": [
            {"startMs": 2000, "endMs": 2400, "word": "Hi", "confidence": 0.92, "speaker": "Bob"},
            {"startMs": 2500, "endMs": 3000, "word": "Alice", "confidence": 0.96, "speaker": "Bob"},
        ],
    }

    formatted_text = transcript_to_text(transcript)
    assert formatted_text == "Alice: Hello, everyone.\n\nBob: Hi Alice!"
