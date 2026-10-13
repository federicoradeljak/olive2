"""Meeting chat API tests (port of chat.test.ts)."""

from __future__ import annotations

import inspect
import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import text

from olive.app import create_app
from olive.db import create_db
from olive.layout import meeting_paths
from olive.services.chat import ChatService
from olive.services.llm import LlmService


def test_persists_messages_streams_responses_and_clears_thread(tmp_path: Path) -> None:
    handle = create_db(":memory:")
    meetings_dir = str(tmp_path / "meetings")
    meeting_id = "meeting-chat-1"
    now = int(time.time() * 1000)
    title = "Chat Fixture"
    paths = meeting_paths(meetings_dir, now, title, meeting_id)
    Path(paths.transcripts_dir).mkdir(parents=True, exist_ok=True)
    transcript = {
        "segments": [
            {
                "startMs": 0,
                "endMs": 5000,
                "speaker": "Alice",
                "text": "We will ship the olive feature on Friday.",
            }
        ]
    }
    (Path(paths.folder) / "transcripts/transcript.json").write_text(
        json.dumps(transcript), encoding="utf-8"
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
                  :id, :title, :now, :end, 'upload', 'ready', '[]',
                  NULL, NULL, NULL, :now, :now
                )
                """
            ),
            {"id": meeting_id, "title": title, "now": now, "end": now + 30_000},
        )
        conn.execute(
            text(
                """
                INSERT INTO artifacts (
                  id, meeting_id, recording_id, kind, provider, format, path, created_at
                ) VALUES (
                  'chat-transcript-1', :mid, NULL, 'transcript', 'fixture', 'json',
                  'transcripts/transcript.json', :now
                )
                """
            ),
            {"mid": meeting_id, "now": now},
        )
        conn.execute(
            text(
                "UPDATE meetings SET primary_transcript_artifact_id = 'chat-transcript-1' WHERE id = :mid"
            ),
            {"mid": meeting_id},
        )

    llm_service = LlmService(db=handle.engine, config_dir=str(tmp_path / "config"))
    message_lengths: list[int] = []

    async def fake_stream_text(
        options: dict[str, Any], on_delta: Callable[[str], Any]
    ) -> dict[str, Any]:
        message_lengths.append(len(options.get("messages") or []))
        res = on_delta("The feature ships on Friday.")
        if inspect.isawaitable(res):
            await res
        return {
            "text": "The feature ships on Friday.",
            "provider": "fixture",
            "model": "fixture-model",
            "durationMs": 1,
            "usage": {"inputTokens": 10, "outputTokens": 6, "totalTokens": 16},
        }

    llm_service.stream_text = fake_stream_text  # type: ignore[method-assign]
    llm_service.streamText = fake_stream_text  # type: ignore[assignment]

    chat_service = ChatService(db=handle.engine, meetings_dir=meetings_dir, llm_service=llm_service)
    app = create_app({"db": handle.engine, "meetingsDir": meetings_dir, "chatService": chat_service})
    client = TestClient(app)

    empty_res = client.get(f"/api/meetings/{meeting_id}/chat/messages")
    assert empty_res.status_code == 200
    assert empty_res.json() == {"messages": []}

    first_res = client.post(
        f"/api/meetings/{meeting_id}/chat/messages",
        headers={"accept": "text/event-stream"},
        json={"content": "When will it ship?"},
    )
    assert first_res.status_code == 200
    assert "event: delta" in first_res.text
    assert "event: done" in first_res.text

    second_res = client.post(
        f"/api/meetings/{meeting_id}/chat/messages",
        headers={"accept": "text/event-stream"},
        json={"content": "Repeat that briefly."},
    )
    assert second_res.status_code == 200
    assert message_lengths == [1, 3]

    pop_res = client.get(f"/api/meetings/{meeting_id}/chat/messages")
    msgs = pop_res.json()["messages"]
    assert len(msgs) == 4
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]

    clear_res = client.delete(f"/api/meetings/{meeting_id}/chat/messages")
    assert clear_res.status_code == 200
    assert clear_res.json() == {"status": "cleared"}

    after_res = client.get(f"/api/meetings/{meeting_id}/chat/messages")
    assert after_res.json() == {"messages": []}
    handle.engine.dispose()
