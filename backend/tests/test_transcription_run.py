"""The run lifecycle rules shared by local and cloud transcription."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from cloud_transcription_helpers import seed_cloud_meeting
from olive.db import create_db
from olive.workflows.transcription_run import TranscriptionRun

MEETING_ID = "m-run-1"
STAGE = "local_transcribe"


class Harness:
    def __init__(self, tmp_path: Path) -> None:
        self.handle = create_db(":memory:")
        self.engine = self.handle.engine
        seed_cloud_meeting(self.engine, str(tmp_path / "meetings"), MEETING_ID)
        self.progress: list[dict[str, Any]] = []
        self.completed: list[str] = []

        async def after_complete(meeting_id: str) -> None:
            self.completed.append(meeting_id)

        self.run = TranscriptionRun(
            self.engine,
            now=lambda: 1_700_000_002_000,
            progress=lambda _mid, update: self.progress.append(update),
            after_complete=after_complete,
        )

    def meeting(self) -> dict[str, Any]:
        with self.engine.connect() as conn:
            row = (
                conn.execute(
                    text(
                        "SELECT status, last_error, primary_transcript_artifact_id FROM meetings WHERE id = :id"
                    ),
                    {"id": MEETING_ID},
                )
                .mappings()
                .one()
            )
        return dict(row)

    def row(self, stage: str = STAGE) -> dict[str, Any]:
        with self.engine.connect() as conn:
            row = (
                conn.execute(
                    text("SELECT * FROM stage_runs WHERE meeting_id = :mid AND stage = :stage"),
                    {"mid": MEETING_ID, "stage": stage},
                )
                .mappings()
                .one()
            )
        return dict(row)

    def artifact(self, art_id: str) -> str:
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO artifacts (id, meeting_id, recording_id, kind, provider, format, path, created_at)"
                    " VALUES (:id, :mid, NULL, 'transcript', 'local', 'json', :path, 0)"
                ),
                {"id": art_id, "mid": MEETING_ID, "path": f"transcripts/{art_id}.json"},
            )
        return art_id

    def set_transcript(self, status: str = "ready") -> None:
        art_id = self.artifact("art-old")
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE meetings SET primary_transcript_artifact_id = :aid, status = :st WHERE id = :id"
                ),
                {"aid": art_id, "st": status, "id": MEETING_ID},
            )

    def stages(self) -> list[str]:
        return [str(u["stage"]) for u in self.progress]


@pytest.fixture
def h(tmp_path: Path) -> Harness:
    return Harness(tmp_path)


def test_start_marks_running_and_processing(h: Harness) -> None:
    first = h.run.start(MEETING_ID, STAGE, job_id="job-1")
    again = h.run.start(MEETING_ID, STAGE, job_id="job-2")

    assert first == again
    row = h.row()
    assert (row["status"], row["provider_job_id"], row["attempts"]) == ("running", "job-2", 2)
    assert h.meeting()["status"] == "processing"


def test_start_keeps_a_transcribed_meeting_ready(h: Harness) -> None:
    h.set_transcript()
    h.run.start(MEETING_ID, STAGE)
    assert h.meeting()["status"] == "ready"


async def test_complete_publishes_the_transcript_and_runs_after_complete(h: Harness) -> None:
    h.run.start(MEETING_ID, STAGE, job_id="job-1")

    art_id = h.artifact("art-1")
    await h.run.complete(MEETING_ID, STAGE, transcript_artifact_id=art_id)
    await h.run.complete(MEETING_ID, STAGE, transcript_artifact_id=art_id)

    assert h.meeting() == {"status": "ready", "last_error": None, "primary_transcript_artifact_id": "art-1"}
    assert (h.row()["status"], h.row()["provider_job_id"]) == ("done", "job-1")
    assert h.stages() == ["done", "done"]
    assert h.completed == [MEETING_ID, MEETING_ID]


async def test_fail_without_transcript_marks_the_meeting_errored(h: Harness) -> None:
    h.run.start(MEETING_ID, STAGE)

    assert await h.run.fail(MEETING_ID, STAGE, "boom")

    assert h.meeting()["status"] == "error"
    assert h.meeting()["last_error"] == "boom"
    assert (h.row()["status"], h.row()["last_error"]) == ("error", "boom")
    assert h.progress[-1] == {"stage": "error", "percent": 0, "message": "boom", "error": "boom"}


async def test_fail_with_previous_transcript_keeps_it_ready(h: Harness) -> None:
    h.run.start(MEETING_ID, STAGE)
    h.set_transcript(status="processing")

    await h.run.fail(MEETING_ID, STAGE, "boom")

    assert h.meeting()["status"] == "ready"
    assert h.meeting()["last_error"] == "boom"


async def test_terminal_writes_are_guarded_by_the_owning_job(h: Harness) -> None:
    h.run.start(MEETING_ID, STAGE, job_id="new-run")

    assert not await h.run.fail(MEETING_ID, STAGE, "stale", job_id="old-run")
    assert not await h.run.cancel(MEETING_ID, STAGE, job_id="old-run")

    assert h.row()["status"] == "running"
    assert h.meeting()["status"] == "processing"
    assert h.progress == []


async def test_cancel_after_failure_keeps_the_error(h: Harness) -> None:
    h.run.start(MEETING_ID, STAGE)
    await h.run.fail(MEETING_ID, STAGE, "boom")

    assert not await h.run.cancel(MEETING_ID, STAGE)

    assert h.row()["status"] == "error"
    assert h.meeting()["status"] == "error"
    assert h.stages() == ["error"]


async def test_cancel_restores_pending(h: Harness) -> None:
    h.run.start(MEETING_ID, STAGE)

    assert await h.run.cancel(MEETING_ID, STAGE)

    assert (h.row()["status"], h.row()["last_error"]) == ("cancelled", "Cancelled by user")
    assert h.meeting() == {"status": "pending", "last_error": None, "primary_transcript_artifact_id": None}
    assert h.stages() == ["cancelled"]


async def test_cancel_all_closes_every_active_row_and_drops_checkpoints(h: Harness) -> None:
    h.run.start(MEETING_ID, STAGE)
    h.run.start(MEETING_ID, "diarize")
    with h.engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO stage_checkpoints (meeting_id, stage, run_id, doc, updated_at)"
                " VALUES (:mid, 'diarize', 'r', '{}', 0)"
            ),
            {"mid": MEETING_ID},
        )

    await h.run.cancel_all(MEETING_ID)

    assert h.row()["status"] == "cancelled"
    assert h.row("diarize")["status"] == "cancelled"
    assert h.meeting()["status"] == "pending"
    with h.engine.connect() as conn:
        assert conn.execute(text("SELECT COUNT(*) FROM stage_checkpoints")).scalar() == 0


async def test_on_progress_overrides_the_default_sink(h: Harness) -> None:
    seen: list[Any] = []
    h.run.start(MEETING_ID, STAGE)

    await h.run.fail(MEETING_ID, STAGE, "boom", on_progress=seen.append)

    assert h.progress == []
    assert [(u.stage, u.error) for u in seen] == [("error", "boom")]
