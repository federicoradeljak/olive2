"""Exact tag + facet filtering for GET /api/meetings, /api/tags, and MCP (issue #5)."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db

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


NOW = 1_700_000_000_000


def _seed(handle) -> None:
    with handle.engine.begin() as conn:
        conn.execute(
            text(
                """
                INSERT INTO meetings (
                  id, title, start_time, end_time, source, status, tags,
                  primary_transcript_artifact_id, primary_summary_artifact_id,
                  last_error, created_at, updated_at
                ) VALUES
                  ('m-a', 'Standup', :now, :end, 'upload', 'ready', :tags_a,
                   NULL, NULL, NULL, :now, :now),
                  ('m-b', 'Acme launch planning', :now, :end, 'upload', 'ready', :tags_b,
                   NULL, NULL, NULL, :now, :now),
                  ('m-c', '1:1', :now, :end, 'upload', 'processing', :tags_c,
                   NULL, NULL, NULL, :now, :now)
                """
            ),
            {
                "now": NOW,
                "end": NOW + 60_000,
                "tags_a": json.dumps(["Acme", "q3"]),
                "tags_b": json.dumps(["other"]),
                "tags_c": json.dumps(["acme"]),
            },
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES ('art-sum-a', 'm-a', NULL, 'summary', 'fixture', 'md', 'summaries/a.md', :now)
                """
            ),
            {"now": NOW},
        )
        conn.execute(text("UPDATE meetings SET primary_summary_artifact_id = 'art-sum-a' WHERE id = 'm-a'"))
        conn.execute(
            text(
                "INSERT INTO speakers (id, name, provider_ids, enrolled_at, enrollment_clip_paths, created_at)"
                " VALUES ('spk-1', 'Matt', '{}', NULL, '[]', :now)"
            ),
            {"now": NOW},
        )
        conn.execute(
            text(
                "INSERT INTO meeting_speakers (meeting_id, speaker_id, evidence_artifact_id)"
                " VALUES ('m-a', 'spk-1', NULL)"
            )
        )


def _ids(resp_json) -> set[str]:
    return {m["id"] for m in resp_json["meetings"]}


def test_api_meetings_tag_and_facet_filters() -> None:
    handle = create_db(":memory:")
    _seed(handle)
    client = TestClient(create_app({"db": handle.engine}))

    # Exact tag match is case-insensitive; m-b only mentions Acme in its title.
    assert _ids(client.get("/api/meetings?tags=acme").json()) == {"m-a", "m-c"}
    # Multiple tags are AND-combined (repeatable and comma-separated forms).
    assert _ids(client.get("/api/meetings?tags=Acme&tags=q3").json()) == {"m-a"}
    assert _ids(client.get("/api/meetings?tags=acme,q3").json()) == {"m-a"}
    # search still fuzzy-matches titles AND tags across all three.
    assert _ids(client.get("/api/meetings?search=acme").json()) == {"m-a", "m-b", "m-c"}
    # search composes with tags (AND): title hit m-b is excluded by the tag scope.
    assert _ids(client.get("/api/meetings?search=acme&tags=acme").json()) == {"m-a", "m-c"}

    assert _ids(client.get("/api/meetings?status=processing").json()) == {"m-c"}
    assert _ids(client.get("/api/meetings?hasSummary=true").json()) == {"m-a"}
    assert _ids(client.get("/api/meetings?hasSummary=false").json()) == {"m-b", "m-c"}
    assert _ids(client.get("/api/meetings?speakerId=spk-1").json()) == {"m-a"}
    assert _ids(client.get("/api/meetings?tags=acme&hasSummary=false").json()) == {"m-c"}

    tags_res = client.get("/api/tags")
    assert tags_res.status_code == 200
    assert tags_res.json() == {
        "tags": [
            {"tag": "Acme", "meetingCount": 2},
            {"tag": "other", "meetingCount": 1},
            {"tag": "q3", "meetingCount": 1},
        ]
    }
    handle.engine.dispose()


def test_mcp_tag_filters_and_list_tags(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    _seed(handle)
    client = TestClient(create_app({"db": handle.engine, "meetingsDir": str(tmp_path)}))

    _, list_body = _mcp_request(
        client, "tools/call", {"name": "list_meetings", "arguments": {"tags": ["acme"]}}
    )
    got = json.loads(list_body["result"]["content"][0]["text"])
    assert {m["id"] for m in got["meetings"]} == {"m-a", "m-c"}

    _, tags_body = _mcp_request(client, "tools/call", {"name": "list_tags", "arguments": {}})
    tags = json.loads(tags_body["result"]["content"][0]["text"])["tags"]
    assert tags == [
        {"tag": "Acme", "meetingCount": 2},
        {"tag": "other", "meetingCount": 1},
        {"tag": "q3", "meetingCount": 1},
    ]
    handle.engine.dispose()
