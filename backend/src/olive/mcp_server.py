"""Model Context Protocol (MCP) read-only server and tools (port of packages/server/src/mcp/tools.ts)."""

from __future__ import annotations

import json
import re
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from mcp.server.mcpserver import MCPServer
from sqlalchemy import text
from sqlalchemy.engine import Engine

from .layout import meeting_paths
from .services.meetings import get_meeting, list_meetings

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}


def _text_result(value: Any) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(value, indent=2)}]}


def _error_result(error: Any) -> dict[str, Any]:
    return {
        "isError": True,
        "content": [{"type": "text", "text": str(error)}],
    }


def _parse_summary_action_items(summary: str | None) -> list[dict[str, Any]]:
    if not summary:
        return []
    out: list[dict[str, Any]] = []
    for line in summary.splitlines():
        m = re.match(r"^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$", line)
        if m:
            out.append(
                {
                    "text": m.group(2),
                    "completed": m.group(1).lower() == "x",
                }
            )
    return out


def _load_transcript_text(
    db: Engine, meetings_dir: str, meeting: dict[str, Any]
) -> str:
    with db.connect() as conn:
        artifacts = conn.execute(
            text(
                """
                SELECT path, format FROM artifacts
                WHERE meeting_id = :mid AND kind = 'transcript'
                ORDER BY created_at DESC
                """
            ),
            {"mid": meeting["id"]},
        ).mappings().all()

    art = next((a for a in artifacts if a["format"] == "txt"), None) or (
        artifacts[0] if artifacts else None
    )
    if not art:
        return ""
    try:
        folder = Path(
            meeting_paths(
                meetings_dir, int(meeting["startTime"]), meeting["title"], meeting["id"]
            ).folder
        )
        return (folder / art["path"]).read_text(encoding="utf-8")
    except Exception:
        return ""


def _transcript_snippet(text_content: str, query: str) -> str | None:
    idx = text_content.lower().find(query.lower())
    if idx < 0:
        return None
    start = max(0, idx - 160)
    end = min(len(text_content), idx + len(query) + 240)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text_content) else ""
    return f"{prefix}{text_content[start:end].strip()}{suffix}"


def _list_all_meetings(
    db: Engine, meetings_dir: str, query: dict[str, Any]
) -> list[dict[str, Any]]:
    meetings: list[dict[str, Any]] = []
    offset = 0
    while True:
        resp = list_meetings(db, {**query, "limit": 100, "offset": offset}, meetings_dir)
        batch = resp["meetings"]
        meetings.extend(batch)
        total = int(resp["pagination"]["total"])
        offset += len(batch)
        if offset >= total or not batch:
            break
    return meetings


MCP_TOOLS_SPEC: list[dict[str, Any]] = [
    {
        "name": "list_meetings",
        "description": "List Olive meetings with optional text, source, and date filters.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "search": {"type": "string", "description": "Search meeting titles, tags, transcripts, and summaries"},
                "source": {"type": "string", "enum": ["plaud", "upload", "ios-shortcut"]},
                "startTime": {"type": "number"},
                "endTime": {"type": "number"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0},
            },
        },
    },
    {
        "name": "get_meeting",
        "description": "Get a complete Olive meeting record, including transcript and summaries.",
        "inputSchema": {
            "type": "object",
            "required": ["meetingId"],
            "properties": {
                "meetingId": {"type": "string", "description": "Meeting ID"},
            },
        },
    },
    {
        "name": "search_transcripts",
        "description": "Search transcript text across Olive meetings and return matching snippets.",
        "inputSchema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {"type": "string", "description": "Text to search for"},
                "source": {"type": "string", "enum": ["plaud", "upload", "ios-shortcut"]},
                "startTime": {"type": "number"},
                "endTime": {"type": "number"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0},
            },
        },
    },
    {
        "name": "get_action_items",
        "description": "Extract checklist-style action items from Olive meeting summaries.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "meetingId": {"type": "string"},
                "includeCompleted": {"type": "boolean", "default": True},
                "source": {"type": "string", "enum": ["plaud", "upload", "ios-shortcut"]},
                "startTime": {"type": "number"},
                "endTime": {"type": "number"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                "offset": {"type": "integer", "minimum": 0},
            },
        },
    },
    {
        "name": "list_speakers",
        "description": "List Olive speaker profiles and meeting counts.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_speaker_profile",
        "description": "Get a speaker profile and associated meetings.",
        "inputSchema": {
            "type": "object",
            "required": ["speakerId"],
            "properties": {
                "speakerId": {"type": "string", "description": "Speaker ID"},
            },
        },
    },
]


async def execute_mcp_tool(
    tool_name: str,
    arguments: dict[str, Any],
    *,
    db: Engine,
    meetings_dir: str,
    speaker_service: Any,
) -> dict[str, Any]:
    try:
        if tool_name == "list_meetings":
            resp = list_meetings(
                db,
                {
                    "search": arguments.get("search"),
                    "source": arguments.get("source"),
                    "startTime": arguments.get("startTime"),
                    "endTime": arguments.get("endTime"),
                    "limit": arguments.get("limit"),
                    "offset": arguments.get("offset"),
                },
                meetings_dir,
            )
            return _text_result({"meetings": resp["meetings"], "pagination": resp["pagination"]})

        if tool_name == "get_meeting":
            meeting_id = str(arguments.get("meetingId") or "")
            detail = get_meeting(db, meeting_id, meetings_dir)
            if not detail:
                return _error_result("Meeting not found")
            return _text_result(detail.model_dump())

        if tool_name == "search_transcripts":
            query = str(arguments.get("query") or "").strip()
            if not query:
                return _error_result("query is required")
            limit = int(arguments.get("limit") or 50)
            offset = int(arguments.get("offset") or 0)
            candidates = _list_all_meetings(
                db,
                meetings_dir,
                {
                    "source": arguments.get("source"),
                    "startTime": arguments.get("startTime"),
                    "endTime": arguments.get("endTime"),
                },
            )
            matches: list[dict[str, Any]] = []
            for m in candidates:
                txt = _load_transcript_text(db, meetings_dir, m)
                snippet = _transcript_snippet(txt, query)
                if snippet:
                    matches.append({"meeting": m, "snippet": snippet})
            return _text_result(
                {
                    "matches": matches[offset : offset + limit],
                    "pagination": {"limit": limit, "offset": offset, "total": len(matches)},
                }
            )

        if tool_name == "get_action_items":
            meeting_id = arguments.get("meetingId")
            include_completed = arguments.get("includeCompleted", True)
            limit = int(arguments.get("limit") or 50)
            offset = int(arguments.get("offset") or 0)
            if meeting_id:
                d = get_meeting(db, str(meeting_id), meetings_dir)
                if not d:
                    return _error_result("Meeting not found")
                meetings_list = [d.meeting.model_dump()]
            else:
                meetings_list = _list_all_meetings(
                    db,
                    meetings_dir,
                    {
                        "source": arguments.get("source"),
                        "startTime": arguments.get("startTime"),
                        "endTime": arguments.get("endTime"),
                    },
                )
            action_items: list[dict[str, Any]] = []
            for m in meetings_list:
                d = get_meeting(db, m["id"], meetings_dir)
                for item in _parse_summary_action_items(d.summaryContent if d else None):
                    if include_completed or not item["completed"]:
                        action_items.append(
                            {
                                "meetingId": m["id"],
                                "meetingTitle": m["title"],
                                **item,
                            }
                        )
            return _text_result(
                {
                    "actionItems": action_items[offset : offset + limit],
                    "pagination": {"limit": limit, "offset": offset, "total": len(action_items)},
                }
            )

        if tool_name == "list_speakers":
            list_fn = getattr(speaker_service, "list_speakers", None) or getattr(
                speaker_service, "listSpeakers", None
            )
            if not callable(list_fn):
                return _error_result("Speaker service unavailable")
            s_res: Any = list_fn()
            speakers = await s_res if hasattr(s_res, "__await__") else s_res
            return _text_result({"speakers": speakers})

        if tool_name == "get_speaker_profile":
            speaker_id = str(arguments.get("speakerId") or "")
            get_fn = getattr(speaker_service, "get_speaker", None) or getattr(
                speaker_service, "getSpeaker", None
            )
            if not callable(get_fn):
                return _error_result("Speaker service unavailable")
            g_res: Any = get_fn(speaker_id)
            spk = await g_res if hasattr(g_res, "__await__") else g_res
            if not spk:
                return _error_result("Speaker not found")
            return _text_result(spk)

        return _error_result(f"Unknown tool: {tool_name}")
    except Exception as exc:
        return _error_result(exc)


def create_mcp_server(options: dict[str, Any]) -> MCPServer:
    server = MCPServer("olive")
    return server


createMcpServer = create_mcp_server


async def handle_mcp_request(
    *,
    request: Request,
    db: Engine,
    meetings_dir: str,
    speaker_service: Any,
    mcp_token: str | None,
    bind_host: str,
) -> Response:
    # 1. Host / Origin validation when bound to loopback
    if bind_host in LOOPBACK_HOSTS:
        host_hdr = (request.headers.get("host") or "127.0.0.1").split(":", 1)[0].strip().lower()
        if host_hdr and host_hdr not in LOOPBACK_HOSTS:
            return JSONResponse({"error": "Forbidden host header"}, status_code=403)
        origin_hdr = request.headers.get("origin")
        if origin_hdr:
            parsed_orig = urllib.parse.urlparse(origin_hdr)
            orig_host = (parsed_orig.hostname or "").lower()
            if orig_host not in LOOPBACK_HOSTS:
                return JSONResponse({"error": "Forbidden origin header"}, status_code=403)

    # 2. Bearer token authentication
    if mcp_token:
        auth_header = request.headers.get("authorization") or ""
        if auth_header != f"Bearer {mcp_token}":
            return JSONResponse(
                {"error": "Unauthorized"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )

    if request.method == "OPTIONS":
        return Response(status_code=204)

    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(
            {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}},
            status_code=400,
        )

    rpc_id = payload.get("id") if isinstance(payload, dict) else None
    method = payload.get("method") if isinstance(payload, dict) else None
    params = (payload.get("params") or {}) if isinstance(payload, dict) else {}

    if method == "initialize":
        result = {
            "protocolVersion": params.get("protocolVersion") or "2025-11-25",
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "olive", "version": "0.2.0"},
        }
        return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": result})

    if method == "notifications/initialized":
        return Response(status_code=202)

    if method == "tools/list":
        return JSONResponse(
            {"jsonrpc": "2.0", "id": rpc_id, "result": {"tools": MCP_TOOLS_SPEC}}
        )

    if method == "tools/call":
        tool_name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        tool_res = await execute_mcp_tool(
            tool_name,
            arguments if isinstance(arguments, dict) else {},
            db=db,
            meetings_dir=meetings_dir,
            speaker_service=speaker_service,
        )
        return JSONResponse({"jsonrpc": "2.0", "id": rpc_id, "result": tool_res})

    return JSONResponse(
        {
            "jsonrpc": "2.0",
            "id": rpc_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"},
        },
        status_code=400,
    )
