"""Meeting split tests: transcript payload splitting (no ffmpeg needed)."""

from __future__ import annotations

import pytest

from olive.services.split import _delete_stale_enhanced_files, split_transcript_payload


def test_split_dict_shape_reanchors_part_b() -> None:
    raw = {
        "segments": [
            {"startMs": 0, "endMs": 60_000, "speaker": "Alice", "text": "hello"},
            {"startMs": 60_000, "endMs": 120_000, "speaker": "Bob", "text": "world"},
            {"startMs": 1_800_000, "endMs": 1_860_000, "speaker": "Alice", "text": "commute"},
        ],
        "language": "en",
    }
    part_a, part_b = split_transcript_payload(raw, 1_800_000)
    assert [s["text"] for s in part_a["segments"]] == ["hello", "world"]
    assert [s["text"] for s in part_b["segments"]] == ["commute"]
    assert part_b["segments"][0]["startMs"] == 0
    assert part_a["durationMs"] == 120_000
    assert part_b["durationMs"] == 60_000
    assert part_a["language"] == "en"


def test_split_bare_list_shape() -> None:
    raw = [
        {"startMs": 0, "endMs": 10_000, "speaker": "A", "text": "one"},
        {"startMs": 20_000, "endMs": 30_000, "speaker": "B", "text": "two"},
    ]
    part_a, part_b = split_transcript_payload(raw, 15_000)
    assert isinstance(part_a, list) and isinstance(part_b, list)
    assert [s["text"] for s in part_a] == ["one"]
    assert part_b[0]["startMs"] == 5_000


def test_split_straddling_midpoint_rule() -> None:
    raw = {"segments": [{"startMs": 0, "endMs": 100_000, "speaker": "A", "text": "long"}]}
    part_a, part_b = split_transcript_payload(raw, 20_000)
    assert len(part_a["segments"]) == 0
    assert len(part_b["segments"]) == 1
    assert part_b["segments"][0]["startMs"] == 0


def test_split_words_divide_text() -> None:
    raw = {
        "segments": [
            {
                "startMs": 0,
                "endMs": 10_000,
                "speaker": "A",
                "text": "hello world",
                "words": [
                    {"startMs": 0, "endMs": 4_000, "word": "hello"},
                    {"startMs": 6_000, "endMs": 10_000, "word": "world"},
                ],
            }
        ]
    }
    part_a, part_b = split_transcript_payload(raw, 5_000)
    assert part_a["segments"][0]["text"] == "hello"
    assert part_b["segments"][0]["text"] == "world"


def test_split_rejects_unknown_shape() -> None:
    with pytest.raises(ValueError):
        split_transcript_payload({"nonsense": True}, 1000)


def test_delete_stale_enhanced_files_removes_derivatives(tmp_path) -> None:
    from pathlib import Path

    folder = Path(tmp_path)
    (folder / "audio").mkdir()
    stale = folder / "audio" / "rec123.enhanced.mp3"
    stale.write_bytes(b"stale")
    other_variant = folder / "audio" / "rec123.enhanced.wav"
    other_variant.write_bytes(b"stale")
    keep = folder / "audio" / "other.enhanced.mp3"
    keep.write_bytes(b"keep")

    _delete_stale_enhanced_files(folder, "rec123")

    assert not stale.exists()
    assert not other_variant.exists()
    assert keep.exists()


def test_delete_stale_enhanced_files_missing_folder_ok(tmp_path) -> None:
    from pathlib import Path

    # No audio/ dir at all: must not raise (split must never fail on cleanup).
    _delete_stale_enhanced_files(Path(tmp_path), "rec123")
