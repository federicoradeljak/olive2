"""Summary generation service and API tests (port of summaries.test.ts)."""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import meeting_paths
from olive.services.llm import LlmService
from olive.services.meetings import get_meeting
from olive.services.summaries import SummaryService
from olive.services.templates import TemplateService


def _create_test_context(tmp_path: Path):
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    Path(meetings_dir).mkdir(parents=True, exist_ok=True)

    template_service = TemplateService(handle.engine)
    llm_service = LlmService(db=handle.engine, config_dir=str(tmp_path / "config"))

    async def fake_generate_text(options: dict[str, Any]) -> dict[str, Any]:
        await asyncio.sleep(0.05)
        prompt = str(options.get("prompt") or "")
        return {
            "text": f"# Generated Summary for Prompt\n\nPrompt was:\n{prompt[:100]}...",
            "provider": options.get("provider") or "google",
            "model": options.get("model") or "gemini-2.5-flash",
            "durationMs": 150,
            "usage": {"inputTokens": 120, "outputTokens": 45, "totalTokens": 165},
        }

    llm_service.generate_text = fake_generate_text  # type: ignore[method-assign]
    llm_service.generateText = fake_generate_text  # type: ignore[assignment]

    summary_service = SummaryService(
        db=handle.engine,
        meetings_dir=meetings_dir,
        llm_service=llm_service,
        template_service=template_service,
    )
    return handle, meetings_dir, llm_service, template_service, summary_service


def _seed_meeting_with_transcript(engine, meetings_dir: str) -> tuple[str, str]:
    now = int(time.time() * 1000)
    meeting_id = "meeting-summary-1"
    title = "Product Roadmap Sync"

    paths = meeting_paths(meetings_dir, now, title, meeting_id)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)

    transcript = {
        "segments": [
            {
                "startMs": 0,
                "endMs": 5000,
                "speaker": "Alice",
                "text": "Welcome everyone. Let's discuss Q4 roadmap goals.",
            },
            {
                "startMs": 5200,
                "endMs": 12000,
                "speaker": "Bob",
                "text": "We completed the authentication migration on time.",
            },
        ]
    }
    transcript_rel = "transcripts/transcript.json"
    (Path(paths.folder) / transcript_rel).write_text(json.dumps(transcript), encoding="utf-8")
    transcript_art_id = "artifact-transcript-1"

    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, :title, :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "title": title, "now": now, "end": now + 600_000},
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES (
                  :aid, :mid, NULL, 'transcript', 'speechmatics', 'json', :path, :now
                )
                """
            ),
            {"aid": transcript_art_id, "mid": meeting_id, "path": transcript_rel, "now": now},
        )
        conn.execute(
            text("UPDATE meetings SET primary_transcript_artifact_id = :aid WHERE id = :mid"),
            {"aid": transcript_art_id, "mid": meeting_id},
        )

    return meeting_id, transcript_art_id


async def test_generates_and_stores_summary_artifact(tmp_path: Path) -> None:
    handle, meetings_dir, _, _, summary_service = _create_test_context(tmp_path)
    meeting_id, _ = _seed_meeting_with_transcript(handle.engine, meetings_dir)

    res = await summary_service.generate_summary({"meetingId": meeting_id})
    assert res["artifactId"]
    assert "Generated Summary" in res["content"]
    assert res["isPrimary"] is True

    detail = get_meeting(handle.engine, meeting_id, meetings_dir)
    assert detail is not None
    assert detail.meeting.primarySummaryArtifactId == res["artifactId"]
    assert len(detail.summaries) == 1
    assert detail.summaries[0].id == res["artifactId"]
    assert detail.summaries[0].isPrimary is True
    handle.engine.dispose()


async def test_start_summary_generation_runs_in_background_and_tracks_status(
    tmp_path: Path,
) -> None:
    handle, meetings_dir, _, _, summary_service = _create_test_context(tmp_path)
    meeting_id, _ = _seed_meeting_with_transcript(handle.engine, meetings_dir)

    status = await summary_service.start_summary_generation({"meetingId": meeting_id})
    assert status.stage == "running"
    assert summary_service.get_summary_generation_status(meeting_id).stage == "running"

    with pytest.raises(RuntimeError, match="already in progress"):
        await summary_service.start_summary_generation({"meetingId": meeting_id})

    final = summary_service.get_summary_generation_status(meeting_id)
    for _ in range(100):
        if final and final.stage != "running":
            break
        await asyncio.sleep(0.02)
        final = summary_service.get_summary_generation_status(meeting_id)

    assert final is not None
    assert final.stage == "done"
    assert final.artifactId
    handle.engine.dispose()


async def test_validates_transcript_before_backgrounding_and_manages_primary_fallback(
    tmp_path: Path,
) -> None:
    handle, meetings_dir, _, template_service, summary_service = _create_test_context(tmp_path)
    meeting_id, _ = _seed_meeting_with_transcript(handle.engine, meetings_dir)

    templates = await template_service.list_templates()
    exec_tpl = next(t for t in templates if t.name == "Executive Summary")
    action_tpl = next(t for t in templates if "Action Items" in t.name)

    sum1 = await summary_service.generate_summary(
        {"meetingId": meeting_id, "templateId": exec_tpl.id, "setPrimary": True}
    )
    sum2 = await summary_service.generate_summary(
        {"meetingId": meeting_id, "templateId": action_tpl.id, "setPrimary": False}
    )

    detail = get_meeting(handle.engine, meeting_id, meetings_dir)
    assert detail is not None
    assert len(detail.summaries) == 2
    assert detail.meeting.primarySummaryArtifactId == sum1["artifactId"]

    await summary_service.delete_summary(meeting_id, sum1["artifactId"])
    detail_after = get_meeting(handle.engine, meeting_id, meetings_dir)
    assert detail_after is not None
    assert len(detail_after.summaries) == 1
    assert detail_after.meeting.primarySummaryArtifactId == sum2["artifactId"]

    await summary_service.delete_summary(meeting_id, sum2["artifactId"])
    detail_empty = get_meeting(handle.engine, meeting_id, meetings_dir)
    assert detail_empty is not None
    assert len(detail_empty.summaries) == 0
    assert detail_empty.meeting.primarySummaryArtifactId is None

    # Remove transcript and verify start_summary_generation fails upfront
    with handle.engine.begin() as conn:
        conn.execute(
            text("UPDATE meetings SET primary_transcript_artifact_id = NULL WHERE id = :mid"),
            {"mid": meeting_id},
        )
        conn.execute(text("DELETE FROM artifacts WHERE meeting_id = :mid"), {"mid": meeting_id})

    with pytest.raises(ValueError, match="No transcript found"):
        await summary_service.start_summary_generation({"meetingId": meeting_id})

    handle.engine.dispose()


async def test_summaries_api_and_full_text_search(tmp_path: Path) -> None:
    import httpx

    handle, meetings_dir, llm_service, template_service, summary_service = _create_test_context(
        tmp_path
    )
    meeting_id, _ = _seed_meeting_with_transcript(handle.engine, meetings_dir)
    app = create_app(
        {
            "db": handle.engine,
            "meetingsDir": meetings_dir,
            "summaryService": summary_service,
            "llmService": llm_service,
            "templateService": template_service,
        }
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://localhost"
    ) as client:
        res = await client.post(
            f"/api/meetings/{meeting_id}/summarize", json={"setPrimary": True}
        )
        assert res.status_code == 202
        assert res.json()["started"] is True

        artifact_id = None
        for _ in range(100):
            st = (await client.get(f"/api/meetings/{meeting_id}/summarize/status")).json()
            if st.get("status", {}).get("stage") == "done":
                artifact_id = st["status"]["artifactId"]
                break
            await asyncio.sleep(0.02)
        assert artifact_id is not None

        primary_res = await client.post(
            f"/api/meetings/{meeting_id}/summaries/{artifact_id}/primary"
        )
        assert primary_res.status_code == 200

        # Full-text search in transcript
        search_res = await client.get("/api/meetings?search=authentication")
        assert search_res.status_code == 200
        assert len(search_res.json()["meetings"]) == 1

        del_res = await client.delete(f"/api/meetings/{meeting_id}/summaries/{artifact_id}")
        assert del_res.status_code == 200

    handle.engine.dispose()
