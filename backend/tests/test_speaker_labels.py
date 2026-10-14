"""Generic speaker labels are transcript labels, not people."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import text

from olive.db import create_db
from olive.layout import meeting_paths
from olive.services.speakers import SpeakerService
from olive.speaker_labels import is_generic_speaker_label


@pytest.mark.parametrize(
    "label",
    [
        "Speaker 1",
        "speaker 12",
        "Speaker1",
        "SPEAKER_00",
        "Speaker-2",
        "S1",
        "s 3",
        "Unknown",
        "unknown 2",
        "UU",
        "spk 1",
        "Participant 2",
        "Speaker",
        "Speaker A",
        "Speaker AA",
        "Speaker #1",
        "Guest 1",
        "Unknown Speaker",
        "Unknown Speaker 2",
        "",
        "  ",
        None,
    ],
)
def test_generic_speaker_labels(label: str | None) -> None:
    assert is_generic_speaker_label(label) is True


@pytest.mark.parametrize(
    "label",
    ["Alice", "Matt Cowger", "Speaker Name", "Sara Speaker", "S. Smith", "Al S1man"],
)
def test_real_names_are_not_generic(label: str) -> None:
    assert is_generic_speaker_label(label) is False


async def test_list_speakers_hides_preexisting_generic_rows(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    now = 1_700_000_000_000
    with handle.engine.begin() as conn:
        for sid, name in [("sp-1", "Speaker 1"), ("sp-2", "S2"), ("sp-3", "Alice")]:
            conn.execute(
                text(
                    """
                    INSERT INTO speakers (
                      id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                    ) VALUES (:id, :name, '{}', NULL, '[]', :now)
                    """
                ),
                {"id": sid, "name": name, "now": now},
            )

    service = SpeakerService({"db": handle.engine, "configDir": str(tmp_path / "config")})
    listed = await service.list_speakers()
    assert [s["name"] for s in listed] == ["Alice"]
    handle.engine.dispose()


async def test_confirm_generic_segment_does_not_mint_a_person(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    config_dir = str(tmp_path / "config")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-confirm-generic"

    paths = meeting_paths(meetings_dir, now, "Confirm Generic", meeting_id)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "transcripts/local.json").write_text(
        json.dumps(
            {
                "language": "en",
                "segments": [
                    {"startMs": 0, "endMs": 2000, "speaker": "Speaker 1", "text": "Hello."},
                ],
            }
        ),
        encoding="utf-8",
    )
    (Path(paths.folder) / "transcripts/local.txt").write_text("Speaker 1: Hello.\n", encoding="utf-8")

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Confirm Generic', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 2000},
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES ('art-1', :mid, NULL, 'transcript', 'local', 'json',
                          'transcripts/local.json', :now)
                """
            ),
            {"mid": meeting_id, "now": now},
        )
        conn.execute(
            text("UPDATE meetings SET primary_transcript_artifact_id = 'art-1' WHERE id = :id"),
            {"id": meeting_id},
        )

    service = SpeakerService(
        {"db": handle.engine, "configDir": config_dir, "meetingsDir": meetings_dir, "now": lambda: now}
    )
    result = await service.confirm_meeting_segment_speaker({"meetingId": meeting_id, "segmentIndex": 0})

    assert "speaker" not in result
    # Label is preserved in the transcript; the turn is just marked verified.
    assert result["transcript"]["segments"][0]["speaker"] == "Speaker 1"
    assert result["transcript"]["segments"][0]["verified"] is True
    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM speakers")).mappings().all() == []
        assert conn.execute(text("SELECT * FROM meeting_speakers")).mappings().all() == []
    handle.engine.dispose()


def test_resolve_or_create_rejects_generic_person_name(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    service = SpeakerService({"db": handle.engine, "configDir": str(tmp_path / "config")})
    with pytest.raises(ValueError, match="generic speaker label"):
        service._resolve_or_create_speaker(speaker_name="Speaker 3", current_time=1)
    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT * FROM speakers")).mappings().all() == []
    handle.engine.dispose()
