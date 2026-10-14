"""SpeakerService, voiceprint enrollment, segment editing, and profile rebuild tests (port of speakers.test.ts)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import meeting_paths
from olive.ml import cosine_similarity, encode_wav, load_audio_samples
from olive.services.speakers import SpeakerService

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "audio"
FIXTURE_MULTI_SPEAKER_PATH = FIXTURES_DIR / "sample-multi-speaker.wav"
FIXTURE_SPEECHMATICS_PATH = FIXTURES_DIR / "speechmatics-sample.wav"

AUDIO_BYTES = encode_wav(np.zeros(16000 * 4, dtype=np.float32), 16000)

def _create_single_voice_wav(
    freq_hz: float = 220.0, duration_sec: float = 4.0, sample_rate: int = 16000
) -> bytes:
    num_samples = int(sample_rate * duration_sec)
    t = np.arange(num_samples, dtype=np.float32) / float(sample_rate)
    samples = 0.5 * np.sin(2.0 * np.pi * freq_hz * t) + 0.2 * np.sin(2.0 * np.pi * (freq_hz * 2.0) * t)
    return encode_wav(samples, sample_rate)


async def test_enrolls_speaker_stores_local_voiceprint_and_saves_clip(
    tmp_path: Path,
) -> None:
    handle = create_db(":memory:")
    config_dir = str(tmp_path / "config")
    now = 1_700_000_000_000

    service = SpeakerService(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "now": lambda: now,
        }
    )

    speaker = await service.enroll_speaker(
        {
            "name": "Matt",
            "audioBytes": AUDIO_BYTES,
            "mime": "audio/wav",
            "filename": "matt-intro.wav",
        }
    )

    assert speaker["name"] == "Matt"
    assert speaker["enrolledAt"] == now
    # Local voiceprints are the only identity store: no Speechmatics ids.
    assert "speechmatics" not in speaker["providerIds"]
    assert len(speaker["providerIds"]["local"]) == 1
    assert len(speaker["enrollmentClipPaths"]) == 1

    clip_disk_path = Path(config_dir) / speaker["enrollmentClipPaths"][0]
    assert clip_disk_path.exists()
    assert len(clip_disk_path.read_bytes()) == len(AUDIO_BYTES)

    listed = await service.list_speakers()
    assert len(listed) == 1
    assert listed[0]["name"] == "Matt"
    assert listed[0]["meetingCount"] == 0
    handle.engine.dispose()


async def test_in_meeting_speaker_reassignment_and_merge_speakers(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    config_dir = str(tmp_path / "config")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-reassign-1"

    paths = meeting_paths(meetings_dir, now, "Planning Sync", meeting_id)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)

    initial_transcript = {
        "segments": [
            {"startMs": 0, "endMs": 2000, "speaker": "S1", "text": "Let's review the architecture."},
            {"startMs": 2500, "endMs": 5000, "speaker": "S2", "text": "Looks great to me."},
            {"startMs": 5500, "endMs": 8000, "speaker": "S1", "text": "Let's ship it."},
        ],
        "language": "en",
        "durationMs": 8000,
        "speakers": [
            {"label": "S1", "speaker_identifiers": ["voiceprint-matt-1", "voiceprint-matt-2"]},
            {"label": "S2", "speaker_identifiers": ["voiceprint-other-1"]},
        ],
    }

    (Path(paths.folder) / "transcripts/speechmatics.json").write_text(
        json.dumps(initial_transcript, indent=2), encoding="utf-8"
    )
    (Path(paths.folder) / "transcripts/speechmatics.txt").write_text(
        "S1: Let's review the architecture.\n\nS2: Looks great to me.\n\nS1: Let's ship it.",
        encoding="utf-8",
    )

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Planning Sync', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 8000},
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES
                  ('art-sm-json', :mid, NULL, 'transcript', 'speechmatics', 'json', 'transcripts/speechmatics.json', :now),
                  ('art-sm-txt', :mid, NULL, 'transcript', 'speechmatics', 'txt', 'transcripts/speechmatics.txt', :now)
                """
            ),
            {"mid": meeting_id, "now": now},
        )
        conn.execute(
            text("UPDATE meetings SET primary_transcript_artifact_id = 'art-sm-json' WHERE id = :id"),
            {"id": meeting_id},
        )

    service = SpeakerService(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "now": lambda: now + 100,
        }
    )
    app = create_app(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "speakerService": service,
        }
    )
    client = TestClient(app)

    reassign_res = client.post(
        f"/api/meetings/{meeting_id}/speakers/reassign",
        json={"fromLabel": "S1", "toSpeakerName": "Matt Cowger", "adoptVoiceprint": True},
    )
    assert reassign_res.status_code == 200
    result = reassign_res.json()
    assert result["speaker"]["name"] == "Matt Cowger"
    assert result["updatedSegmentsCount"] == 2
    assert result["extractedVoiceprintsCount"] == 2
    assert result["speaker"]["providerIds"]["speechmatics"] == [
        "voiceprint-matt-1",
        "voiceprint-matt-2",
    ]

    updated_txt = (Path(paths.folder) / "transcripts/speechmatics.txt").read_text(encoding="utf-8")
    assert "Matt Cowger: Let's review the architecture." in updated_txt
    assert "Matt Cowger: Let's ship it." in updated_txt
    assert "S2: Looks great to me." in updated_txt

    second_speaker = await service.enroll_speaker({"name": "Matthew C.", "audioBytes": AUDIO_BYTES})
    merge_res = client.post(
        "/api/speakers/merge",
        json={
            "sourceSpeakerId": second_speaker["id"],
            "targetSpeakerId": result["speaker"]["id"],
        },
    )
    assert merge_res.status_code == 200
    merged_data = merge_res.json()
    assert merged_data["speaker"]["id"] == result["speaker"]["id"]
    assert "voiceprint-matt-1" in merged_data["speaker"]["providerIds"]["speechmatics"]

    all_speakers = await service.list_speakers()
    assert len(all_speakers) == 1
    assert all_speakers[0]["name"] == "Matt Cowger"
    handle.engine.dispose()


async def test_coalesces_sequential_turns_and_prunes_placeholder_speakers(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    config_dir = str(tmp_path / "config")
    meetings_dir = str(tmp_path / "meetings")
    now = 1_700_000_000_000
    meeting_id = "m-coalesce-test"
    artifact_id = "art-trans-1"

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Coalescing & Pruning Test', :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "now": now, "end": now + 60000},
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES (
                  :aid, :mid, NULL, 'transcript', 'local', 'json', 'transcripts/local.json', :now
                )
                """
            ),
            {"aid": artifact_id, "mid": meeting_id, "now": now},
        )
        conn.execute(
            text("UPDATE meetings SET primary_transcript_artifact_id = :aid WHERE id = :id"),
            {"aid": artifact_id, "id": meeting_id},
        )
        for sid, sname in [("sp-1", "Speaker 1"), ("sp-2", "Speaker 2"), ("sp-3", "Speaker 3")]:
            conn.execute(
                text(
                    """
                    INSERT INTO speakers (
                      id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                    ) VALUES (:id, :name, '{}', NULL, '[]', :now)
                    """
                ),
                {"id": sid, "name": sname, "now": now},
            )
            conn.execute(
                text(
                    """
                    INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                    VALUES (:mid, :sid, :aid)
                    """
                ),
                {"mid": meeting_id, "sid": sid, "aid": artifact_id},
            )

    paths = meeting_paths(meetings_dir, now, "Coalescing & Pruning Test", meeting_id)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)
    transcript_data = {
        "language": "en",
        "segments": [
            {"startMs": 0, "endMs": 2000, "speaker": "Speaker 1", "text": "It's weird."},
            {"startMs": 3000, "endMs": 4500, "speaker": "Speaker 2", "text": "strategic stuff."},
            {
                "startMs": 5000,
                "endMs": 8000,
                "speaker": "Speaker 1",
                "text": "Is that a reasonable statement?",
            },
            {
                "startMs": 8500,
                "endMs": 11000,
                "speaker": "Speaker 3",
                "text": "Okay, I got a weird strategic stuff for you.",
            },
            {
                "startMs": 11500,
                "endMs": 14000,
                "speaker": "Speaker 1",
                "text": "I was just talking to Colin.",
            },
        ],
    }
    (Path(paths.folder) / "transcripts/local.json").write_text(
        json.dumps(transcript_data, indent=2), encoding="utf-8"
    )

    service = SpeakerService(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "now": lambda: now + 100,
        }
    )
    app = create_app(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "speakerService": service,
        }
    )
    client = TestClient(app)

    res1 = client.post(
        f"/api/meetings/{meeting_id}/speakers/reassign",
        json={"fromLabel": "Speaker 1", "toSpeakerName": "Matt Cowger", "adoptVoiceprint": False},
    )
    assert res1.status_code == 200

    res2 = client.post(
        f"/api/meetings/{meeting_id}/speakers/reassign",
        json={"fromLabel": "Speaker 3", "toSpeakerName": "Matt Cowger", "adoptVoiceprint": False},
    )
    assert res2.status_code == 200

    updated_json = json.loads((Path(paths.folder) / "transcripts/local.json").read_text(encoding="utf-8"))
    assert len(updated_json["segments"]) == 3
    assert updated_json["segments"][0]["speaker"] == "Matt Cowger"
    assert updated_json["segments"][1]["speaker"] == "Speaker 2"
    assert updated_json["segments"][2]["speaker"] == "Matt Cowger"
    assert (
        updated_json["segments"][2]["text"]
        == "Is that a reasonable statement? Okay, I got a weird strategic stuff for you. I was just talking to Colin."
    )

    rem_speakers = await service.list_speakers()
    names = [s["name"] for s in rem_speakers]
    assert "Matt Cowger" in names
    assert "Speaker 2" in names
    assert "Speaker 1" not in names
    assert "Speaker 3" not in names
    handle.engine.dispose()


async def test_enforces_protected_anchor_and_diversity_cap_and_rebuild_profiles(
    tmp_path: Path,
) -> None:
    handle = create_db(":memory:")
    config_dir = str(tmp_path / "config")
    meetings_dir = str(tmp_path / "meetings")
    now_counter = 1_700_000_000_000

    def next_now() -> int:
        nonlocal now_counter
        now_counter += 1
        return now_counter

    service = SpeakerService(
        {
            "db": handle.engine,
            "configDir": config_dir,
            "meetingsDir": meetings_dir,
            "now": next_now,
        }
    )

    # 1. Duration & duplicate validation from local-transcription.test.ts
    short_wav = _create_single_voice_wav(220.0, 1.0)
    with pytest.raises(ValueError, match="too short"):
        await service.enroll_speaker({"name": "David", "audioBytes": short_wav, "mime": "audio/wav"})

    long_wav = _create_single_voice_wav(220.0, 40.0)
    with pytest.raises(ValueError, match="too long"):
        await service.enroll_speaker({"name": "David", "audioBytes": long_wav, "mime": "audio/wav"})

    # 2. Protected Anchor + Diversity Cap (max 8 clips)
    t4 = np.arange(16000 * 4, dtype=np.float32) / 16000.0
    anchor_samples = (
        0.5 * np.sin(2 * np.pi * 220 * t4)
        + 0.25 * np.sin(2 * np.pi * 440 * t4)
        + 0.1 * np.sin(2 * np.pi * 660 * t4)
    ).astype(np.float32)
    anchor_wav = encode_wav(anchor_samples, 16000)

    initial_speaker = await service.enroll_speaker(
        {"name": "Alice", "audioBytes": anchor_wav, "provider": "local"}
    )
    assert len(initial_speaker["enrollmentClipPaths"]) == 1
    anchor_path = initial_speaker["enrollmentClipPaths"][0]

    # Duplicate content across speakers rejected
    with pytest.raises(ValueError, match='already enrolled under speaker "Alice"'):
        await service.enroll_speaker({"name": "Bob", "audioBytes": anchor_wav, "provider": "local"})

    total_sec = 60
    t60 = np.arange(16000 * total_sec, dtype=np.float32) / 16000.0
    seg_idx_arr = np.floor(t60 / 4.5)
    base_freq = 220.0 + ((seg_idx_arr + 1.0) * 3.5)
    h2 = 0.25 + ((seg_idx_arr + 1.0) * 0.03)
    h3 = 0.08 + ((seg_idx_arr + 1.0) * 0.015)
    meeting_samples = (
        0.5 * np.sin(2 * np.pi * base_freq * t60)
        + h2 * np.sin(2 * np.pi * (base_freq * 2.0) * t60)
        + h3 * np.sin(2 * np.pi * (base_freq * 3.0) * t60)
    ).astype(np.float32)
    meeting_wav = encode_wav(meeting_samples, 16000)

    meeting_id = "m-cap-test"
    base_ts = 1_700_000_000_000
    paths = meeting_paths(meetings_dir, base_ts, "Cap Test Meeting", meeting_id)
    Path(paths.audio_dir).mkdir(parents=True, exist_ok=True)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)
    (Path(paths.folder) / "audio/meeting.wav").write_bytes(meeting_wav)

    segments = [
        {
            "startMs": i * 4500,
            "endMs": i * 4500 + 4000,
            "speaker": "Speaker 1",
            "text": f"Segment {i}",
        }
        for i in range(10)
    ]
    transcript_data = {"language": "en", "durationMs": total_sec * 1000, "segments": segments}
    (Path(paths.folder) / "transcripts/local.json").write_text(
        json.dumps(transcript_data, indent=2), encoding="utf-8"
    )
    (Path(paths.folder) / "transcripts/local.txt").write_text("Transcript content", encoding="utf-8")

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, 'Cap Test Meeting', :ts, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :ts, :ts
                )
                """
            ),
            {"id": meeting_id, "ts": base_ts, "end": base_ts + total_sec * 1000},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  'rec-cap-1', :mid, 'audio/meeting.wav', 'audio/wav', :dur, :sz,
                  'fake-sha-cap', 'upload', NULL, :ts
                )
                """
            ),
            {"mid": meeting_id, "dur": total_sec * 1000, "sz": len(meeting_wav), "ts": base_ts},
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES
                  ('art-cap-json', :mid, 'rec-cap-1', 'transcript', 'local', 'json', 'transcripts/local.json', :ts),
                  ('art-cap-txt', :mid, 'rec-cap-1', 'transcript', 'local', 'txt', 'transcripts/local.txt', :ts)
                """
            ),
            {"mid": meeting_id, "ts": base_ts},
        )
        conn.execute(
            text("UPDATE meetings SET primary_transcript_artifact_id = 'art-cap-json' WHERE id = :id"),
            {"id": meeting_id},
        )

    for i in range(7):
        res = await service.confirm_meeting_segment_speaker(
            {"meetingId": meeting_id, "segmentIndex": i, "speakerId": initial_speaker["id"]}
        )
        assert res["voiceprintEnrolled"] is True
        assert res["voiceprintStatus"] == "enrolled"

    upd_spk = (await service.get_speaker(initial_speaker["id"]))["speaker"]
    assert len(upd_spk["enrollmentClipPaths"]) == 8
    assert upd_spk["enrollmentClipPaths"][0] == anchor_path
    clip1_path = upd_spk["enrollmentClipPaths"][1]

    res8 = await service.confirm_meeting_segment_speaker(
        {"meetingId": meeting_id, "segmentIndex": 7, "speakerId": initial_speaker["id"]}
    )
    assert res8["voiceprintEnrolled"] is True
    assert res8["voiceprintStatus"] == "enrolled_evicted"

    upd_spk = (await service.get_speaker(initial_speaker["id"]))["speaker"]
    assert len(upd_spk["enrollmentClipPaths"]) == 8
    assert upd_spk["enrollmentClipPaths"][0] == anchor_path
    assert clip1_path not in upd_spk["enrollmentClipPaths"]
    assert not (Path(config_dir) / clip1_path).exists()

    # Re-confirming identical segment 7 is skipped as redundant
    redundant_res = await service.confirm_meeting_segment_speaker(
        {"meetingId": meeting_id, "segmentIndex": 7, "speakerId": initial_speaker["id"]}
    )
    assert redundant_res["voiceprintEnrolled"] is False
    assert redundant_res["voiceprintStatus"] == "redundant_skipped"

    handle.engine.dispose()


async def test_rebuild_speaker_profiles_cleans_contaminated_clips_and_extracts_vectors(
    tmp_path: Path,
) -> None:
    handle = create_db(":memory:")
    config_dir = str(tmp_path / "config")
    now = 1_700_000_000_000

    service = SpeakerService({"db": handle.engine, "configDir": config_dir, "now": lambda: now})

    spk1_id = "spk-matt"
    spk2_id = "spk-harrison"

    dec_sm = await load_audio_samples(
        {"audioBytes": FIXTURE_SPEECHMATICS_PATH.read_bytes(), "enhance": False}, 16000
    )
    dec_multi = await load_audio_samples(
        {"audioBytes": FIXTURE_MULTI_SPEAKER_PATH.read_bytes(), "enhance": False}, 16000
    )

    clip_a = encode_wav(dec_sm.samples[: 16000 * 5], 16000)
    spk1_folder = Path(config_dir) / "speakers" / spk1_id
    spk1_folder.mkdir(parents=True, exist_ok=True)
    (spk1_folder / "clip_a.wav").write_bytes(clip_a)

    clip_b = encode_wav(dec_multi.samples[16000 * 5 : 16000 * 11], 16000)
    spk2_folder = Path(config_dir) / "speakers" / spk2_id
    spk2_folder.mkdir(parents=True, exist_ok=True)
    (spk1_folder / "clip_shared.wav").write_bytes(clip_b)
    (spk2_folder / "clip_shared.wav").write_bytes(clip_b)

    clip_c = encode_wav(dec_multi.samples[16000 * 22 : 16000 * 27], 16000)
    (spk2_folder / "clip_c.wav").write_bytes(clip_c)

    clip_d = encode_wav(dec_multi.samples[:8000], 16000)
    (spk2_folder / "clip_too_short.wav").write_bytes(clip_d)

    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO speakers (
                  id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                ) VALUES
                  (:s1, 'Matt', :pids, :now, :c1, :now),
                  (:s2, 'Harrison', :pids, :now, :c2, :now)
                """
            ),
            {
                "s1": spk1_id,
                "s2": spk2_id,
                "pids": json.dumps({"local": ["old-corrupted-vector"]}),
                "now": now,
                "c1": json.dumps([f"speakers/{spk1_id}/clip_a.wav", f"speakers/{spk1_id}/clip_shared.wav"]),
                "c2": json.dumps(
                    [
                        f"speakers/{spk2_id}/clip_shared.wav",
                        f"speakers/{spk2_id}/clip_c.wav",
                        f"speakers/{spk2_id}/clip_too_short.wav",
                    ]
                ),
            },
        )

    rebuild_res = await service.rebuild_speaker_profiles()
    assert rebuild_res["processedSpeakers"] == 2
    assert rebuild_res["cleanedClipsCount"] >= 2
    assert rebuild_res["retainedClipsCount"] == 2

    matt = next(s for s in rebuild_res["speakers"] if s["name"] == "Matt")
    harrison = next(s for s in rebuild_res["speakers"] if s["name"] == "Harrison")

    assert matt["enrollmentClipPaths"] == [f"speakers/{spk1_id}/clip_a.wav"]
    assert len(matt["providerIds"]["local"]) == 1
    matt_vec = json.loads(matt["providerIds"]["local"][0])
    assert len(matt_vec) == 256

    assert harrison["enrollmentClipPaths"] == [f"speakers/{spk2_id}/clip_c.wav"]
    assert len(harrison["providerIds"]["local"]) == 1
    harrison_vec = json.loads(harrison["providerIds"]["local"][0])
    assert len(harrison_vec) == 256

    sim = cosine_similarity(matt_vec, harrison_vec)
    assert sim < 0.70

    # Verify auto-rebuild check records local_embedding_model in sync_state
    did_rebuild = await service.ensure_embedding_model_current()
    assert did_rebuild is True
    did_rebuild_again = await service.ensure_embedding_model_current()
    assert did_rebuild_again is False
    handle.engine.dispose()
