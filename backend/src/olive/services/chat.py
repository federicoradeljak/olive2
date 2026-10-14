"""Meeting chat service with SSE streaming (port of packages/server/src/chat/service.ts)."""

from __future__ import annotations

import inspect
import json
import time
import uuid
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from ..db import DbHandle, get_db
from ..layout import meeting_paths
from ..schemas import ChatMessage, ChatUsage, LlmGenerateResult
from ..settings import resolve_paths
from .llm import LlmService


def _parse_usage(value: str | None) -> ChatUsage | None:
    if not value:
        return None
    try:
        return ChatUsage.model_validate(json.loads(value))
    except Exception:
        return None


def _to_chat_message(row: Mapping[Any, Any]) -> ChatMessage:
    return ChatMessage(
        id=row["id"],
        meetingId=row["meeting_id"],
        role=row["role"],
        content=row["content"],
        provider=row.get("provider"),
        model=row.get("model"),
        usage=_parse_usage(row.get("usage")),
        createdAt=int(row["created_at"]),
    )


def _format_transcript(raw_transcript: str) -> str:
    try:
        parsed = json.loads(raw_transcript)
        segs = parsed.get("segments") if isinstance(parsed, dict) else None
        if isinstance(segs, list):
            return "\n\n".join(
                f"{seg.get('speaker') or 'Unknown'}: {seg.get('text', '')}"
                for seg in segs
                if isinstance(seg, dict)
            )
        if isinstance(parsed, list):
            # Plaud raw transcript: [{speaker, content, ...}, ...]. Without
            # this branch the LLM received a raw JSON dump instead of a
            # readable transcript.
            lines = [
                f"{seg.get('speaker') or 'Unknown'}: {seg.get('text', seg.get('content', ''))}"
                for seg in parsed
                if isinstance(seg, dict)
            ]
            if lines:
                return "\n\n".join(lines)
    except Exception:
        pass
    return raw_transcript


async def _call_llm_stream(
    llm_service: Any,
    options: dict[str, Any],
    on_delta: Callable[[str], Any],
) -> LlmGenerateResult:
    inst_dict = getattr(llm_service, "__dict__", {})
    fn = (
        inst_dict.get("stream_text")
        or inst_dict.get("streamText")
        or getattr(llm_service, "stream_text", None)
        or getattr(llm_service, "streamText", None)
    )
    if not callable(fn):
        raise AttributeError("llm_service has no stream_text/streamText method")
    res = fn(options, on_delta)
    if inspect.isawaitable(res):
        res = await res
    return res if isinstance(res, LlmGenerateResult) else LlmGenerateResult.model_validate(res)


class ChatService:
    def __init__(
        self,
        options: dict[str, Any] | None = None,
        *,
        db: Engine | DbHandle | None = None,
        meetings_dir: str | None = None,
        llm_service: LlmService | Any | None = None,
    ) -> None:
        opts = options or {}
        raw_db = db or opts.get("db")
        if isinstance(raw_db, DbHandle):
            self.db: Engine = raw_db.engine
        elif isinstance(raw_db, Engine):
            self.db = raw_db
        else:
            self.db = get_db()

        self.meetings_dir = str(
            meetings_dir
            or opts.get("meetingsDir")
            or opts.get("meetings_dir")
            or resolve_paths().meetings_dir
        )
        self.llm_service = (
            llm_service or opts.get("llmService") or opts.get("llm_service") or LlmService(db=self.db)
        )

    async def get_messages(self, meeting_id: str) -> list[ChatMessage]:
        with self.db.connect() as conn:
            meeting = conn.execute(
                text("SELECT id FROM meetings WHERE id = :id"),
                {"id": meeting_id},
            ).first()
            if not meeting:
                raise ValueError(f"Meeting not found: {meeting_id}")

            rows = (
                conn.execute(
                    text(
                        "SELECT * FROM chat_messages WHERE meeting_id = :mid ORDER BY created_at ASC, id ASC"
                    ),
                    {"mid": meeting_id},
                )
                .mappings()
                .all()
            )
        return [_to_chat_message(r) for r in rows]

    getMessages = get_messages

    async def clear_messages(self, meeting_id: str) -> None:
        with self.db.begin() as conn:
            meeting = conn.execute(
                text("SELECT id FROM meetings WHERE id = :id"),
                {"id": meeting_id},
            ).first()
            if not meeting:
                raise ValueError(f"Meeting not found: {meeting_id}")
            conn.execute(text("DELETE FROM chat_messages WHERE meeting_id = :mid"), {"mid": meeting_id})

    clearMessages = clear_messages

    async def stream_message(self, options: dict[str, Any]) -> ChatMessage:
        meeting_id = str(options.get("meetingId") or options.get("meeting_id") or "")
        content = str(options.get("content") or "").strip()
        on_delta = options.get("onDelta") or options.get("on_delta") or (lambda _d: None)
        if not content:
            raise ValueError("Message content is required")

        system_prompt = await self._load_meeting_context(meeting_id)
        history = await self.get_messages(meeting_id)
        now = int(time.time() * 1000)
        created_at = max(now, (history[-1].createdAt + 1) if history else now)

        user_msg = ChatMessage(
            id=str(uuid.uuid4()),
            meetingId=meeting_id,
            role="user",
            content=content,
            provider=None,
            model=None,
            usage=None,
            createdAt=created_at,
        )

        with self.db.begin() as conn:
            conn.execute(
                text(
                    """
                    INSERT INTO chat_messages (
                      id, meeting_id, role, content, provider, model, usage, created_at
                    ) VALUES (
                      :id, :mid, :role, :content, NULL, NULL, NULL, :created_at
                    )
                    """
                ),
                {
                    "id": user_msg.id,
                    "mid": user_msg.meetingId,
                    "role": user_msg.role,
                    "content": user_msg.content,
                    "created_at": user_msg.createdAt,
                },
            )

        try:
            messages_payload = [
                {
                    "role": m.role,
                    "content": m.content,
                    "timestamp": m.createdAt,
                }
                for m in history
            ] + [{"role": "user", "content": content, "timestamp": created_at}]

            res = await _call_llm_stream(
                self.llm_service,
                {
                    "systemPrompt": system_prompt,
                    "prompt": content,
                    "messages": messages_payload,
                },
                on_delta,
            )

            asst_created_at = max(int(time.time() * 1000), created_at + 1)
            if res.usage is not None:
                try:
                    from .usage import estimate_llm_cost

                    if res.usage.cost is None:
                        res.usage.cost = estimate_llm_cost(
                            res.provider,
                            res.model,
                            res.usage.inputTokens,
                            res.usage.outputTokens,
                        )
                except Exception:
                    pass
            asst_msg = ChatMessage(
                id=str(uuid.uuid4()),
                meetingId=meeting_id,
                role="assistant",
                content=res.text,
                provider=res.provider,
                model=res.model,
                usage=res.usage,
                createdAt=asst_created_at,
            )

            with self.db.begin() as conn:
                conn.execute(
                    text(
                        """
                        INSERT INTO chat_messages (
                          id, meeting_id, role, content, provider, model, usage, created_at
                        ) VALUES (
                          :id, :mid, :role, :content, :provider, :model, :usage, :created_at
                        )
                        """
                    ),
                    {
                        "id": asst_msg.id,
                        "mid": asst_msg.meetingId,
                        "role": asst_msg.role,
                        "content": asst_msg.content,
                        "provider": asst_msg.provider,
                        "model": asst_msg.model,
                        "usage": json.dumps(asst_msg.usage.model_dump(exclude_none=True))
                        if asst_msg.usage
                        else None,
                        "created_at": asst_msg.createdAt,
                    },
                )
            try:
                from .usage import record_llm_usage

                record_llm_usage(
                    self.db,
                    meeting_id=meeting_id,
                    kind="chat",
                    provider=res.provider,
                    model=res.model,
                    input_tokens=res.usage.inputTokens if res.usage else 0,
                    output_tokens=res.usage.outputTokens if res.usage else 0,
                    total_tokens=res.usage.totalTokens if res.usage else 0,
                    created_at=asst_created_at,
                    source=f"chat:{asst_msg.id}",
                    detail={"messageId": asst_msg.id},
                )
            except Exception:
                pass
            return asst_msg
        except Exception:
            with self.db.begin() as conn:
                conn.execute(text("DELETE FROM chat_messages WHERE id = :id"), {"id": user_msg.id})
            raise

    streamMessage = stream_message

    async def _load_meeting_context(self, meeting_id: str) -> str:
        with self.db.connect() as conn:
            meeting = (
                conn.execute(
                    text("SELECT * FROM meetings WHERE id = :id"),
                    {"id": meeting_id},
                )
                .mappings()
                .first()
            )
            if not meeting:
                raise ValueError(f"Meeting not found: {meeting_id}")

            artifacts = (
                conn.execute(
                    text("SELECT * FROM artifacts WHERE meeting_id = :mid ORDER BY created_at ASC"),
                    {"mid": meeting_id},
                )
                .mappings()
                .all()
            )

            speakers = (
                conn.execute(
                    text(
                        """
                    SELECT speakers.name
                    FROM meeting_speakers
                    INNER JOIN speakers ON speakers.id = meeting_speakers.speaker_id
                    WHERE meeting_speakers.meeting_id = :mid
                    """
                    ),
                    {"mid": meeting_id},
                )
                .mappings()
                .all()
            )

        folder = Path(
            meeting_paths(
                self.meetings_dir, int(meeting["start_time"]), meeting["title"], meeting["id"]
            ).folder
        )

        def read_artifact(rel_path: str) -> str | None:
            fp = folder / rel_path
            return fp.read_text(encoding="utf-8") if fp.exists() else None

        primary_tid = meeting.get("primary_transcript_artifact_id")
        transcript_art = next(
            (a for a in artifacts if a["id"] == primary_tid or a["kind"] == "transcript"),
            None,
        )
        transcript_raw = read_artifact(transcript_art["path"]) if transcript_art else None
        summaries: list[str] = []
        for art in artifacts:
            if art["kind"] == "summary":
                c = read_artifact(art["path"])
                if c:
                    summaries.append(f"Summary ({art['provider']}):\n{c}")

        date_str = datetime.fromtimestamp(int(meeting["start_time"]) / 1000.0).strftime("%b %d, %Y, %I:%M %p")
        transcript_text = (
            _format_transcript(transcript_raw)
            if transcript_raw
            else "No transcript is available for this meeting."
        )
        summary_text = (
            "\n\n---\n\n".join(summaries) if summaries else "No summaries are available for this meeting."
        )
        speaker_names = ", ".join(s["name"] for s in speakers) or "Unknown participants"

        return (
            "You are Olive's meeting assistant. Answer questions using only the meeting context below. "
            "Be accurate and concise. If the answer is not present in the context, say that you cannot "
            "find it in this meeting. Do not invent facts, decisions, dates, owners, or speaker identities.\n\n"
            f"Meeting: {meeting['title']}\n"
            f"Date: {date_str}\n"
            f"Participants: {speaker_names}\n\n"
            f"Summaries:\n{summary_text}\n\n"
            f"Transcript:\n{transcript_text}"
        )
