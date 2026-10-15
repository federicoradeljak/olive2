"""MCP write tools tests (issue #8): speakers, tags, titles with plan/confirm guards."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import meeting_paths

MCP_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Host": "127.0.0.1",
}


def _mcp_request(
    client: TestClient,
    method: str,
    params: dict[str, Any] | None = None,
) -> tuple[Any, dict[str, Any]]:
    res = client.post(
        "/mcp",
        headers=MCP_HEADERS,
        json={
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": method,
            "params": params or {},
        },
    )
    return res, res.json()


def _call_tool(client: TestClient, name: str, args: dict[str, Any]) -> dict[str, Any]:
    _, body = _mcp_request(client, "tools/call", {"name": name, "arguments": args})
    return body["result"]


def _parse_text(result: dict[str, Any]) -> Any:
    assert result.get("isError") is not True, result
    return json.loads(result["content"][0]["text"])


def _seed_meeting(engine, meetings_dir: str, meeting_id: str, title: str, tags: list[str]) -> Path:
    now = 1_700_000_000_000
    paths = meeting_paths(meetings_dir, now, title, meeting_id)
    Path(paths.folder).mkdir(parents=True, exist_ok=True)
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES (
                  :id, :title, :now, :end, 'upload', 'ready', :tags,
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {
                "id": meeting_id,
                "title": title,
                "now": now,
                "end": now + 60_000,
                "tags": json.dumps(tags),
            },
        )
    return Path(paths.folder)


def _seed_speaker(engine, speaker_id: str, name: str, meeting_id: str | None = None) -> None:
    now = 1_700_000_000_000
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO speakers (
                  id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at
                ) VALUES (:id, :name, '{}', NULL, '[]', :now)
                """
            ),
            {"id": speaker_id, "name": name, "now": now},
        )
        if meeting_id:
            conn.execute(
                text(
                    """
                    INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)
                    VALUES (:mid, :sid, NULL)
                    """
                ),
                {"mid": meeting_id, "sid": speaker_id},
            )


def test_write_tools_hidden_by_default(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    app = create_app({"db": handle.engine, "meetingsDir": str(tmp_path / "meetings")})
    client = TestClient(app)
    _, body = _mcp_request(client, "tools/list")
    names = [t["name"] for t in body["result"]["tools"]]
    assert "update_speaker" not in names
    assert "merge_speakers" not in names
    assert "delete_speaker" not in names
    assert "set_meeting_tags" not in names
    assert "update_meeting_title" not in names

    res = _call_tool(client, "update_speaker", {"speakerId": "x", "newName": "Y"})
    assert res.get("isError") is True
    assert "OLIVE_MCP_WRITE=1" in res["content"][0]["text"]
    handle.engine.dispose()


def test_write_tools_listed_when_enabled(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    app = create_app(
        {
            "db": handle.engine,
            "meetingsDir": str(tmp_path / "meetings"),
            "mcpWriteEnabled": True,
        }
    )
    client = TestClient(app)
    _, body = _mcp_request(client, "tools/list")
    names = [t["name"] for t in body["result"]["tools"]]
    for expected in [
        "update_speaker",
        "merge_speakers",
        "delete_speaker",
        "set_meeting_tags",
        "update_meeting_title",
    ]:
        assert expected in names
    handle.engine.dispose()


def test_update_speaker_dry_run_guard_and_apply(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    _seed_speaker(handle.engine, "spk-1", "Matt")
    app = create_app({"db": handle.engine, "meetingsDir": meetings_dir, "mcpWriteEnabled": True})
    client = TestClient(app)

    plan = _parse_text(
        _call_tool(
            client,
            "update_speaker",
            {"speakerId": "spk-1", "newName": "Matthew Cowger", "dryRun": True},
        )
    )
    assert plan["dryRun"] is True
    assert plan["currentName"] == "Matt"
    assert plan["wouldUpdate"] is True
    # dryRun mutates nothing
    with handle.engine.connect() as conn:
        row = conn.execute(text("SELECT name FROM speakers WHERE id='spk-1'")).mappings().first()
        assert row and row["name"] == "Matt"

    # expectedName mismatch aborts
    err = _call_tool(
        client,
        "update_speaker",
        {"speakerId": "spk-1", "newName": "Matthew Cowger", "expectedName": "Wrong"},
    )
    assert err.get("isError") is True
    assert "Precondition failed" in err["content"][0]["text"]

    applied = _parse_text(
        _call_tool(
            client,
            "update_speaker",
            {"speakerId": "spk-1", "newName": "Matthew Cowger", "expectedName": "Matt"},
        )
    )
    assert applied["previousName"] == "Matt"
    assert applied["speaker"]["name"] == "Matthew Cowger"
    handle.engine.dispose()


def test_merge_and_delete_speaker_flow(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    mid = "meeting-merge-1"
    _seed_meeting(handle.engine, meetings_dir, mid, "Merge fixture", [])
    _seed_speaker(handle.engine, "spk-src", "Matt", mid)
    _seed_speaker(handle.engine, "spk-tgt", "Matthew Cowger", mid)
    app = create_app({"db": handle.engine, "meetingsDir": meetings_dir, "mcpWriteEnabled": True})
    client = TestClient(app)

    plan = _parse_text(
        _call_tool(
            client,
            "merge_speakers",
            {"sourceSpeakerId": "spk-src", "targetSpeakerId": "spk-tgt", "dryRun": True},
        )
    )
    assert plan["dryRun"] is True
    assert plan["source"]["name"] == "Matt"
    assert plan["target"]["name"] == "Matthew Cowger"
    assert plan["wouldDeleteSourceId"] == "spk-src"

    # guard mismatch aborts
    err = _call_tool(
        client,
        "merge_speakers",
        {
            "sourceSpeakerId": "spk-src",
            "targetSpeakerId": "spk-tgt",
            "expectedSourceName": "Nobody",
        },
    )
    assert err.get("isError") is True

    merged = _parse_text(
        _call_tool(
            client,
            "merge_speakers",
            {
                "sourceSpeakerId": "spk-src",
                "targetSpeakerId": "spk-tgt",
                "expectedSourceName": "Matt",
                "expectedTargetName": "Matthew Cowger",
            },
        )
    )
    assert merged["speaker"]["id"] == "spk-tgt"
    with handle.engine.connect() as conn:
        assert conn.execute(text("SELECT 1 FROM speakers WHERE id='spk-src'")).first() is None

    # delete with plan then apply
    del_plan = _parse_text(_call_tool(client, "delete_speaker", {"speakerId": "spk-tgt", "dryRun": True}))
    assert del_plan["wouldDelete"] is True
    assert del_plan["name"] == "Matthew Cowger"
    deleted = _parse_text(
        _call_tool(
            client,
            "delete_speaker",
            {"speakerId": "spk-tgt", "expectedName": "Matthew Cowger"},
        )
    )
    assert deleted["deleted"] is True
    handle.engine.dispose()


def test_set_meeting_tags_guard_and_apply(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    mid = "meeting-tags-1"
    _seed_meeting(handle.engine, meetings_dir, mid, "Tags fixture", ["acme"])
    app = create_app({"db": handle.engine, "meetingsDir": meetings_dir, "mcpWriteEnabled": True})
    client = TestClient(app)

    plan = _parse_text(
        _call_tool(
            client,
            "set_meeting_tags",
            {"meetingId": mid, "tags": ["acme", "q3"], "dryRun": True},
        )
    )
    assert plan["currentTags"] == ["acme"]
    assert plan["wouldUpdate"] is True

    err = _call_tool(
        client,
        "set_meeting_tags",
        {"meetingId": mid, "tags": ["acme", "q3"], "expectedTags": ["stale"]},
    )
    assert err.get("isError") is True
    assert "Precondition failed" in err["content"][0]["text"]

    applied = _parse_text(
        _call_tool(
            client,
            "set_meeting_tags",
            {"meetingId": mid, "tags": ["acme", "q3"], "expectedTags": ["acme"]},
        )
    )
    assert applied["previousTags"] == ["acme"]
    assert applied["meeting"]["tags"] == ["acme", "q3"]
    handle.engine.dispose()


def test_update_meeting_title_guard_apply_and_folder_rename(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    mid = "meeting-title-1"
    old_folder = _seed_meeting(handle.engine, meetings_dir, mid, "ASR guess Acme", [])
    assert old_folder.exists()
    app = create_app({"db": handle.engine, "meetingsDir": meetings_dir, "mcpWriteEnabled": True})
    client = TestClient(app)

    plan = _parse_text(
        _call_tool(
            client,
            "update_meeting_title",
            {"meetingId": mid, "newTitle": "Acme Q3 review", "dryRun": True},
        )
    )
    assert plan["currentTitle"] == "ASR guess Acme"
    assert plan["wouldUpdate"] is True
    assert old_folder.exists()

    err = _call_tool(
        client,
        "update_meeting_title",
        {"meetingId": mid, "newTitle": "Acme Q3 review", "expectedTitle": "Stale"},
    )
    assert err.get("isError") is True

    applied = _parse_text(
        _call_tool(
            client,
            "update_meeting_title",
            {
                "meetingId": mid,
                "newTitle": "Acme Q3 review",
                "expectedTitle": "ASR guess Acme",
            },
        )
    )
    assert applied["previousTitle"] == "ASR guess Acme"
    assert applied["meeting"]["title"] == "Acme Q3 review"
    assert not old_folder.exists()
    handle.engine.dispose()


def test_write_enabled_via_env(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("OLIVE_MCP_WRITE", "1")
    handle = create_db(":memory:")
    app = create_app({"db": handle.engine, "meetingsDir": str(tmp_path / "meetings")})
    client = TestClient(app)
    _, body = _mcp_request(client, "tools/list")
    names = [t["name"] for t in body["result"]["tools"]]
    assert "update_speaker" in names
    handle.engine.dispose()


def _seed_recording(engine, meeting_id: str) -> None:
    now = 1_700_000_000_000
    with engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO recordings (
                  id, meeting_id, path, mime, duration_ms, size_bytes, sha256,
                  provider, provider_recording_id, created_at
                ) VALUES (
                  :rid, :mid, 'audio/meeting.m4a', 'audio/mp4', 60000, 1234,
                  'sha-test', 'upload', NULL, :now
                )
                """
            ),
            {"rid": f"rec-{meeting_id}", "mid": meeting_id, "now": now},
        )


class _StubTranscription:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []

    async def start_transcription(
        self, meeting_id: str, opts: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        self.calls.append(("start", {"meetingId": meeting_id, **(opts or {})}))
        return {
            "status": "running",
            "jobId": f"job-{meeting_id[:8]}",
            "meetingId": meeting_id,
            "alreadyRunning": False,
        }

    async def start_bulk_transcription(self, opts: dict[str, Any] | None = None) -> dict[str, Any]:
        o = dict(opts or {})
        self.calls.append(("bulk", o))
        ids = list(o.get("meetingIds") or [])
        return {
            "bulkId": "bulk-1",
            "results": [{"meetingId": mid, "status": "running"} for mid in ids],
            "queued": len(ids),
        }

    async def cancel_transcription(self, meeting_id: str) -> dict[str, Any]:
        self.calls.append(("cancel", meeting_id))
        return {"success": True, "meetingId": meeting_id}

    async def request_speaker_reidentification(self, meeting_id: str) -> dict[str, Any]:
        self.calls.append(("reidentify", meeting_id))
        return {"status": "queued", "jobId": f"reid-{meeting_id[:8]}", "meetingId": meeting_id}


class _StubSummary:
    async def start_summary_generation(self, opts: dict[str, Any]) -> dict[str, Any]:
        return {"meetingId": opts.get("meetingId"), "stage": "running"}


class _StubTitle:
    async def generate_and_apply(
        self, meeting_id: str, provider: str | None = None, model: str | None = None
    ) -> dict[str, Any]:
        return {
            "meeting": {"id": meeting_id, "title": "Generated Title"},
            "title": "Generated Title",
            "provider": provider or "google",
            "model": model or "gemini-2.5-flash",
        }


class _StubPoller:
    async def retry_meeting_audio(self, meeting_id: str) -> dict[str, Any]:
        return {"status": "queued", "meetingId": meeting_id}


def _write_app(tmp_path: Path, engine, **services: Any):
    return create_app(
        {
            "db": engine,
            "meetingsDir": str(tmp_path / "meetings"),
            "mcpWriteEnabled": True,
            **services,
        }
    )


def test_write_tools_list_includes_second_wave(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    app = _write_app(tmp_path, handle.engine)
    client = TestClient(app)
    _, body = _mcp_request(client, "tools/list")
    names = [t["name"] for t in body["result"]["tools"]]
    for expected in [
        "transcribe_meeting",
        "bulk_transcribe",
        "cancel_transcription",
        "retry_meeting_audio",
        "reidentify_speakers",
        "delete_meeting",
        "update_meeting_start_time",
        "auto_title_meeting",
        "summarize_meeting",
    ]:
        assert expected in names
    handle.engine.dispose()


def test_bulk_tagging_plan_and_apply(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    _seed_meeting(handle.engine, meetings_dir, "m-bulk-1", "Bulk one", ["acme"])
    _seed_meeting(handle.engine, meetings_dir, "m-bulk-2", "Bulk two", [])
    app = _write_app(tmp_path, handle.engine)
    client = TestClient(app)

    plan = _parse_text(
        _call_tool(
            client,
            "set_meeting_tags",
            {"meetingIds": ["m-bulk-1", "m-bulk-2", "missing"], "tags": ["acme", "q3"], "dryRun": True},
        )
    )
    assert plan["mode"] == "bulk"
    assert plan["summary"] == {"total": 3, "wouldUpdate": 2, "notFound": 1}

    applied = _parse_text(
        _call_tool(
            client,
            "set_meeting_tags",
            {"meetingIds": ["m-bulk-1", "m-bulk-2"], "tags": ["acme", "q3"]},
        )
    )
    assert applied["summary"] == {"total": 2, "updated": 2, "notFound": 0}

    err = _call_tool(
        client,
        "set_meeting_tags",
        {"meetingIds": ["m-bulk-1"], "tags": ["x"], "expectedTags": ["acme"]},
    )
    assert err.get("isError") is True
    handle.engine.dispose()


def test_transcribe_meeting_dry_run_and_queue(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    _seed_meeting(handle.engine, meetings_dir, "m-tr-1", "Transcribe me", [])
    _seed_recording(handle.engine, "m-tr-1")
    stub = _StubTranscription()
    app = _write_app(tmp_path, handle.engine, transcriptionService=stub)
    client = TestClient(app)

    plan = _parse_text(_call_tool(client, "transcribe_meeting", {"meetingId": "m-tr-1", "dryRun": True}))
    assert plan["wouldQueue"] is True
    assert stub.calls == []

    queued = _parse_text(
        _call_tool(client, "transcribe_meeting", {"meetingId": "m-tr-1", "provider": "local"})
    )
    assert queued["status"] == "running"
    assert queued["jobId"].startswith("job-")
    assert stub.calls[0][0] == "start"

    err = _call_tool(client, "transcribe_meeting", {"meetingId": "m-tr-1", "provider": "nope"})
    assert err.get("isError") is True
    handle.engine.dispose()


def test_bulk_transcribe_filters_dry_run_and_queue(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    _seed_meeting(handle.engine, meetings_dir, "m-bt-1", "Bulk T one", ["acme"])
    _seed_meeting(handle.engine, meetings_dir, "m-bt-2", "Bulk T two", ["other"])
    stub = _StubTranscription()
    app = _write_app(tmp_path, handle.engine, transcriptionService=stub)
    client = TestClient(app)

    plan = _parse_text(
        _call_tool(client, "bulk_transcribe", {"provider": "local", "tags": ["acme"], "dryRun": True})
    )
    assert plan["mode"] == "filters"
    assert plan["meetingIds"] == ["m-bt-1"]

    queued = _parse_text(_call_tool(client, "bulk_transcribe", {"provider": "local", "tags": ["acme"]}))
    assert queued["operation"] == "bulk_transcribe"
    handle.engine.dispose()


def test_cancel_reidentify_retry_flow(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    _seed_meeting(handle.engine, meetings_dir, "m-cr-1", "Cancel me", [])
    stub = _StubTranscription()
    poller = _StubPoller()
    app = _write_app(tmp_path, handle.engine, transcriptionService=stub, plaudPoller=poller)
    client = TestClient(app)

    cx_plan = _parse_text(_call_tool(client, "cancel_transcription", {"meetingId": "m-cr-1", "dryRun": True}))
    assert cx_plan["wouldCancel"] is True
    cx = _parse_text(_call_tool(client, "cancel_transcription", {"meetingId": "m-cr-1"}))
    assert cx["success"] is True

    ri = _parse_text(_call_tool(client, "reidentify_speakers", {"meetingId": "m-cr-1"}))
    assert ri["status"] == "queued"

    ra = _parse_text(_call_tool(client, "retry_meeting_audio", {"meetingId": "m-cr-1"}))
    assert ra["status"] == "queued"
    handle.engine.dispose()


def test_retry_without_poller_errors(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    _seed_meeting(handle.engine, meetings_dir, "m-nop-1", "No poller", [])
    app = _write_app(tmp_path, handle.engine, transcriptionService=_StubTranscription())
    client = TestClient(app)
    err = _call_tool(client, "retry_meeting_audio", {"meetingId": "m-nop-1"})
    assert err.get("isError") is True
    assert "Plaud" in err["content"][0]["text"]
    handle.engine.dispose()


def test_delete_meeting_guard_and_apply(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    folder = _seed_meeting(handle.engine, meetings_dir, "m-del-1", "Delete me", ["acme"])
    assert folder.exists()
    app = _write_app(tmp_path, handle.engine)
    client = TestClient(app)

    plan = _parse_text(_call_tool(client, "delete_meeting", {"meetingId": "m-del-1", "dryRun": True}))
    assert plan["wouldDelete"] is True
    assert folder.exists()

    err = _call_tool(client, "delete_meeting", {"meetingId": "m-del-1", "expectedTitle": "Stale"})
    assert err.get("isError") is True

    done = _parse_text(
        _call_tool(client, "delete_meeting", {"meetingId": "m-del-1", "expectedTitle": "Delete me"})
    )
    assert done["deleted"] is True
    assert not folder.exists()
    handle.engine.dispose()


def test_update_start_time_auto_title_summarize(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    _seed_meeting(handle.engine, meetings_dir, "m-st-1", "Time me", [])
    app = _write_app(
        tmp_path,
        handle.engine,
        titleService=_StubTitle(),
        summaryService=_StubSummary(),
    )
    client = TestClient(app)

    with handle.engine.connect() as conn:
        cur = conn.execute(text("SELECT start_time FROM meetings WHERE id='m-st-1'")).mappings().first()
        assert cur is not None
        current_start = int(cur["start_time"])

    st_plan = _parse_text(
        _call_tool(
            client,
            "update_meeting_start_time",
            {"meetingId": "m-st-1", "newStartTime": current_start + 86400000, "dryRun": True},
        )
    )
    assert st_plan["wouldUpdate"] is True

    st = _parse_text(
        _call_tool(
            client,
            "update_meeting_start_time",
            {
                "meetingId": "m-st-1",
                "newStartTime": current_start + 86400000,
                "expectedStartTime": current_start,
            },
        )
    )
    assert st["previousStartTime"] == current_start

    at = _parse_text(_call_tool(client, "auto_title_meeting", {"meetingId": "m-st-1"}))
    assert at["title"] == "Generated Title"

    sm = _parse_text(_call_tool(client, "summarize_meeting", {"meetingId": "m-st-1"}))
    assert sm["started"] is True
    handle.engine.dispose()
