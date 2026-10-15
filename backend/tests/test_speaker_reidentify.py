"""Post-facto speaker re-identification tests (speaker_embed queue job)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from olive.db import create_db
from olive.layout import ensure_meeting_folder, meeting_paths
from olive.ml.protocols import DiscoveredSpeakerVoiceprint
from olive.schemas import Transcript, TranscriptSegment
from olive.services.transcription import TranscriptionService
from olive.workflows import QUEUE_SPEAKER_EMBED

NOW = 2_000_000_000_000


def _seed_reidentify_meeting(
    tmp_path: Path,
    *,
    provider: str = "speechmatics",
    with_audio: bool = True,
    with_transcript: bool = True,
    with_vectors: bool = True,
    now: int = NOW,
) -> tuple[Any, TranscriptionService, str, str, str]:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    meeting_id = "22222222-3333-4444-8555-222222222222"
    title = "Reidentify Fixture"
    start = now - 60_000
    paths = ensure_meeting_folder(meeting_paths(meetings_dir, start, title, meeting_id))
    folder = Path(paths.folder)
    audio_rel = "audio/rec.m4a"
    if with_audio:
        (folder / audio_rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / audio_rel).write_bytes(b"fake audio")
    transcript = Transcript(
        segments=[
            TranscriptSegment(startMs=0, endMs=5000, speaker="Speaker 1", text="Hello there."),
            TranscriptSegment(startMs=5000, endMs=12000, speaker="Speaker 2", text="Hi back."),
        ]
    )
    art_path = f"transcripts/{provider}.json"
    if with_transcript:
        (folder / "transcripts").mkdir(parents=True, exist_ok=True)
        (folder / art_path).write_text(
            f"{json.dumps(transcript.model_dump(exclude_none=True), indent=2)}\n", encoding="utf-8"
        )
        (folder / f"transcripts/{provider}.txt").write_text(
            "Speaker 1: Hello there.\nSpeaker 2: Hi back.\n", encoding="utf-8"
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
                  :id, :title, :start, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "title": title, "start": start, "end": start + 60_000, "now": now},
        )
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  'rec-1', :mid, :path, 'audio/mp4', 60000, 10, 'x',
                  'upload', NULL, :now
                )
                """
            ),
            {"mid": meeting_id, "path": audio_rel, "now": now},
        )
        if with_transcript:
            conn.execute(
                text(
                    """
                    INSERT INTO artifacts (
                      id, meeting_id, recording_id, kind, provider, format, path, created_at
                    ) VALUES (
                      'art-tx-json', :mid, 'rec-1', 'transcript', :prov, 'json',
                      :path, :now
                    )
                    """
                ),
                {"mid": meeting_id, "prov": provider, "path": art_path, "now": now},
            )
            conn.execute(
                text("UPDATE meetings SET primary_transcript_artifact_id = 'art-tx-json' WHERE id = :mid"),
                {"mid": meeting_id},
            )
        conn.execute(
            text(
                """
                INSERT INTO speakers (
                  id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                ) VALUES (
                  'spk-matt', 'Matt', :pids, :now, '[]', :now
                )
                """
            ),
            {
                "pids": json.dumps({"local": [json.dumps([0.5, 0.5, 0.5, 0.5])]}) if with_vectors else "{}",
                "now": now,
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO speakers (
                  id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                ) VALUES (
                  'spk-ghost', 'Speaker 1', '{}', NULL, '[]', :now
                )
                """
            ),
            {"now": now},
        )
        if with_transcript:
            conn.execute(
                text(
                    """
                    INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                    VALUES (:mid, 'spk-ghost', 'art-tx-json')
                    """
                ),
                {"mid": meeting_id},
            )
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "speechmaticsClient": object(),
            "assemblyaiClient": object(),
            "now": lambda: now + 5000,
        }
    )
    return handle, service, meeting_id, str(folder), "art-tx-json"


def _matt_identifier(
    calls: list[str],
) -> Any:
    async def _fake(_audio: str, transcript: Transcript, _enrolled: Any, **_kwargs: Any) -> Any:
        calls.append("identify")
        renamed = Transcript(
            segments=[
                TranscriptSegment(startMs=s.startMs, endMs=s.endMs, speaker="Matt", text=s.text)
                for s in transcript.segments
            ]
        )
        return renamed, [
            DiscoveredSpeakerVoiceprint(
                speakerId="spk-matt",
                name="Matt",
                voiceprint=[0.5, 0.5, 0.5, 0.5],
                isEnrolled=True,
                similarityScore=0.9,
            )
        ]

    return _fake


async def test_request_unknown_meeting_raises(tmp_path: Path) -> None:
    _handle, service, _mid, _folder, _art = _seed_reidentify_meeting(tmp_path)
    with pytest.raises(ValueError, match="not found"):
        await service.request_speaker_reidentification("no-such-meeting")


async def test_request_without_transcript_raises(tmp_path: Path) -> None:
    _handle, service, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path, with_transcript=False)
    with pytest.raises(ValueError, match="No transcript"):
        await service.request_speaker_reidentification(meeting_id)


async def test_request_without_audio_raises(tmp_path: Path) -> None:
    _handle, service, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path, with_audio=False)
    with pytest.raises(ValueError, match="[Aa]udio"):
        await service.request_speaker_reidentification(meeting_id)


async def test_request_without_enrolled_voiceprints_raises(tmp_path: Path) -> None:
    _handle, service, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path, with_vectors=False)
    with pytest.raises(ValueError, match="enroll"):
        await service.request_speaker_reidentification(meeting_id)


async def test_request_enqueues_speaker_embed_job(tmp_path: Path, monkeypatch: Any) -> None:
    import olive.services.transcription as tx_mod

    _handle, service, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path)
    calls: list[dict[str, Any]] = []

    async def _fake_ensure(**_kwargs: Any) -> str:
        calls.append({"ensure": True})
        return "dbos://fake"

    async def _fake_enqueue(queue_name: str, _fn: Any, **kwargs: Any) -> Any:
        calls.append({"queue": queue_name, **kwargs})
        return object()

    monkeypatch.setattr(tx_mod, "ensure_dbos_launched_async", _fake_ensure)
    monkeypatch.setattr(tx_mod, "enqueue_stage_job", _fake_enqueue)

    res = await service.request_speaker_reidentification(meeting_id)

    assert res["status"] == "queued"
    assert res["meetingId"] == meeting_id
    assert res["provider"] == "speechmatics"
    job = next(c for c in calls if "queue" in c)
    assert job["queue"] == QUEUE_SPEAKER_EMBED
    assert job["deduplication_id"] == f"reidentify-speakers:{meeting_id}"
    assert str(job["workflow_id"]).startswith(f"reidentify-speakers:{meeting_id}:")
    assert job["label"] == "reidentify-speakers"
    assert job["meeting_id"] == meeting_id
    status = service.get_speaker_reidentification_status(meeting_id)
    assert status is not None and status.stage == "queued"
    assert status.jobId == res["jobId"]
    assert status.provider == "speechmatics"

    # A second request while queued reports the same job as already running.
    res2 = await service.request_speaker_reidentification(meeting_id)
    assert res2["alreadyRunning"] is True
    assert res2["jobId"] == res["jobId"]


async def test_request_delegates_plaud_meetings_to_poller(tmp_path: Path, monkeypatch: Any) -> None:
    import olive.services.transcription as tx_mod
    from olive.workflows import QUEUE_PLAUD_SYNC

    _handle, service, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path, provider="plaud")
    calls: list[dict[str, Any]] = []

    async def _fake_ensure(**_kwargs: Any) -> str:
        return "dbos://fake"

    async def _fake_enqueue(queue_name: str, _fn: Any, **kwargs: Any) -> Any:
        calls.append({"queue": queue_name, **kwargs})
        return object()

    monkeypatch.setattr(tx_mod, "ensure_dbos_launched_async", _fake_ensure)
    monkeypatch.setattr(tx_mod, "enqueue_stage_job", _fake_enqueue)

    class _FakePoller:
        async def run_plaud_speaker_identification(self, mid: str) -> dict[str, Any]:
            return {"meetingId": mid, "status": "renamed", "matched": ["Matt"]}

    service.set_plaud_poller(_FakePoller())
    res = await service.request_speaker_reidentification(meeting_id)

    assert res["status"] == "queued"
    assert res["provider"] == "plaud"
    job = next(c for c in calls if "queue" in c)
    assert job["queue"] == QUEUE_PLAUD_SYNC
    assert job["deduplication_id"] == f"reidentify-speakers:{meeting_id}"
    assert job["label"] == "reidentify-speakers"
    status = service.get_speaker_reidentification_status(meeting_id)
    assert status is not None and status.stage == "queued"
    assert status.jobId == res["jobId"]


async def test_request_plaud_without_poller_raises(tmp_path: Path) -> None:
    _handle, service, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path, provider="plaud")
    with pytest.raises(ValueError, match="[Pp]laud"):
        await service.request_speaker_reidentification(meeting_id)


async def test_run_renames_rewrites_artifacts_and_prunes_stale_links(tmp_path: Path) -> None:
    handle, _svc, meeting_id, folder, art_id = _seed_reidentify_meeting(tmp_path)
    calls: list[str] = []
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": _svc.meetings_dir,
            "speechmaticsClient": object(),
            "assemblyaiClient": object(),
            "cloudSpeakerIdentifier": _matt_identifier(calls),
            "now": lambda: NOW + 5000,
        }
    )
    res = await service.run_speaker_reidentification(meeting_id)

    assert res["status"] == "renamed"
    assert res["matched"] == ["Matt"]
    assert res["renamed"] == {"Speaker 1": "Matt", "Speaker 2": "Matt"}
    assert calls == ["identify"]
    rewritten = json.loads((Path(folder) / "transcripts/speechmatics.json").read_text(encoding="utf-8"))
    assert [s["speaker"] for s in rewritten["segments"]] == ["Matt", "Matt"]
    txt = (Path(folder) / "transcripts/speechmatics.txt").read_text(encoding="utf-8")
    assert "Matt: Hello there." in txt
    assert "Speaker 1" not in txt
    assert "Speaker 2" not in txt

    with handle.engine.connect() as conn:
        links = {
            r["speaker_id"]: r["evidence_artifact_id"]
            for r in conn.execute(text("SELECT * FROM meeting_speakers")).mappings().all()
        }
        speakers = {r["id"]: r["name"] for r in conn.execute(text("SELECT * FROM speakers")).mappings().all()}
        updated = conn.execute(
            text("SELECT updated_at FROM meetings WHERE id = :mid"), {"mid": meeting_id}
        ).scalar()
    # Matt linked to the transcript artifact; the stale "Speaker 1" link was
    # pruned because that label no longer appears in the transcript. The
    # speaker row itself is kept (same as the Plaud path).
    assert links == {"spk-matt": art_id}
    assert speakers["spk-ghost"] == "Speaker 1"
    assert updated == NOW + 5000
    handle.engine.dispose()


async def test_run_keeps_labels_when_identifier_returns_none(tmp_path: Path) -> None:
    handle, _svc, meeting_id, folder, _art = _seed_reidentify_meeting(tmp_path)

    async def _fake_none(*_args: Any, **_kwargs: Any) -> None:
        return None

    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": _svc.meetings_dir,
            "speechmaticsClient": object(),
            "assemblyaiClient": object(),
            "cloudSpeakerIdentifier": _fake_none,
            "now": lambda: NOW + 5000,
        }
    )
    before = (Path(folder) / "transcripts/speechmatics.json").read_text(encoding="utf-8")
    res = await service.run_speaker_reidentification(meeting_id)

    assert res["status"] == "kept-labels"
    assert (Path(folder) / "transcripts/speechmatics.json").read_text(encoding="utf-8") == before
    with handle.engine.connect() as conn:
        links = [
            r["speaker_id"] for r in conn.execute(text("SELECT * FROM meeting_speakers")).mappings().all()
        ]
        updated = conn.execute(
            text("SELECT updated_at FROM meetings WHERE id = :mid"), {"mid": meeting_id}
        ).scalar()
    assert links == ["spk-ghost"]
    assert updated == NOW + 5000
    handle.engine.dispose()


async def test_run_skipped_without_enrolled_voiceprints(tmp_path: Path) -> None:
    handle, _svc, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path, with_vectors=False)
    called: list[str] = []
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": _svc.meetings_dir,
            "speechmaticsClient": object(),
            "assemblyaiClient": object(),
            "cloudSpeakerIdentifier": _matt_identifier(called),
            "now": lambda: NOW + 5000,
        }
    )
    res = await service.run_speaker_reidentification(meeting_id)

    assert res["status"] == "skipped"
    assert called == []
    handle.engine.dispose()


async def test_tracked_run_flips_status_to_done(tmp_path: Path) -> None:
    handle, _svc, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path)
    calls: list[str] = []
    service = TranscriptionService(
        {
            "db": handle.engine,
            "meetingsDir": _svc.meetings_dir,
            "speechmaticsClient": object(),
            "assemblyaiClient": object(),
            "cloudSpeakerIdentifier": _matt_identifier(calls),
            "now": lambda: NOW + 5000,
        }
    )
    service._reidentify_statuses[meeting_id] = service._reidentify_statuses.get(meeting_id) or (
        __import__("olive.schemas", fromlist=["SpeakerReidentificationStatus"]).SpeakerReidentificationStatus(
            meetingId=meeting_id,
            stage="queued",
            startedAt=NOW,
            jobId=f"reidentify-speakers:{meeting_id}:abc123",
            provider="speechmatics",
        )
    )
    res = await service._run_tracked_reidentification(
        meeting_id, f"reidentify-speakers:{meeting_id}:abc123", "speechmatics", False
    )
    assert res["status"] == "renamed"
    status = service.get_speaker_reidentification_status(meeting_id)
    assert status is not None and status.stage == "done"
    assert status.matched == ["Matt"]
    assert status.renamed == {"Speaker 1": "Matt", "Speaker 2": "Matt"}
    with handle.engine.connect() as conn:
        row = (
            conn.execute(
                text(
                    "SELECT status FROM stage_runs WHERE meeting_id = :mid AND stage = 'speaker_reidentify'"
                ),
                {"mid": meeting_id},
            )
            .mappings()
            .first()
        )
    assert row is not None and row["status"] == "done"
    handle.engine.dispose()


async def test_cancel_marks_status_cancelled(tmp_path: Path, monkeypatch: Any) -> None:
    import olive.services.transcription as tx_mod

    _handle, service, meeting_id, _folder, _art = _seed_reidentify_meeting(tmp_path)

    async def _fake_ensure(**_kwargs: Any) -> str:
        return "dbos://fake"

    async def _fake_enqueue(queue_name: str, _fn: Any, **kwargs: Any) -> Any:
        return object()

    async def _fake_cancel(*_args: Any, **_kwargs: Any) -> int:
        return 1

    monkeypatch.setattr(tx_mod, "ensure_dbos_launched_async", _fake_ensure)
    monkeypatch.setattr(tx_mod, "enqueue_stage_job", _fake_enqueue)
    monkeypatch.setattr(tx_mod, "cancel_dbos_workflows_for_meeting", _fake_cancel)

    await service.request_speaker_reidentification(meeting_id)
    res = await service.cancel_speaker_reidentification(meeting_id)
    assert res["success"] is True
    status = service.get_speaker_reidentification_status(meeting_id)
    assert status is not None and status.stage == "cancelled"
