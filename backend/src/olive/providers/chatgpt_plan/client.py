"""Responses API calls billed to the user's ChatGPT plan."""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable, Sequence
from typing import Any

import httpx

from .errors import ChatGptPlanError, error_from_payload, error_from_response

RESPONSES_URL = "https://api.openai.com/v1/responses"
MODELS_URL = "https://api.openai.com/v1/models"
STREAM_TIMEOUT = httpx.Timeout(30.0, read=300.0)


async def _iter_sse_events(res: httpx.Response):
    """Yield the JSON payload of each SSE event (``data:`` lines joined per event)."""
    data_lines: list[str] = []
    async for line in res.aiter_lines():
        if line == "":
            if data_lines:
                raw = "\n".join(data_lines)
                data_lines = []
                if raw.strip() and raw.strip() != "[DONE]":
                    try:
                        yield json.loads(raw)
                    except json.JSONDecodeError:
                        continue
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if data_lines:
        try:
            yield json.loads("\n".join(data_lines))
        except json.JSONDecodeError:
            pass


async def stream_response(
    access_token: str,
    *,
    model: str,
    instructions: str | None,
    messages: Sequence[dict[str, str]],
    on_delta: Callable[[str], Any] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str, dict[str, int] | None]:
    """Run one streamed Responses request; returns the full text and token usage.

    Plan usage requires ``store: false`` and ``stream: true``, sends the whole
    history every time, and rejects sampling fields such as ``temperature``.
    """
    body: dict[str, Any] = {
        "model": model,
        "input": [{"role": m["role"], "content": m["content"]} for m in messages],
        "store": False,
        "stream": True,
    }
    if instructions:
        body["instructions"] = instructions

    text = ""
    usage: dict[str, int] | None = None
    async with httpx.AsyncClient(timeout=STREAM_TIMEOUT, transport=transport) as http:
        async with http.stream(
            "POST",
            RESPONSES_URL,
            headers={"Authorization": f"Bearer {access_token}", "Accept": "text/event-stream"},
            json=body,
        ) as res:
            request_id = res.headers.get("x-request-id")
            if res.status_code != 200:
                raise error_from_response(res, await res.aread())
            async for event in _iter_sse_events(res):
                if not isinstance(event, dict):
                    continue
                kind = event.get("type")
                if kind == "response.output_text.delta":
                    piece = event.get("delta")
                    if isinstance(piece, str) and piece:
                        text += piece
                        if on_delta is not None:
                            cb = on_delta(piece)
                            if inspect.isawaitable(cb):
                                await cb
                elif kind == "response.completed":
                    response = event.get("response") if isinstance(event.get("response"), dict) else {}
                    raw_usage = response.get("usage") if isinstance(response, dict) else None
                    if isinstance(raw_usage, dict):
                        in_tok = int(raw_usage.get("input_tokens") or 0)
                        out_tok = int(raw_usage.get("output_tokens") or 0)
                        usage = {
                            "input": in_tok,
                            "output": out_tok,
                            "total": int(raw_usage.get("total_tokens") or in_tok + out_tok),
                        }
                    return text, usage
                elif kind == "response.failed":
                    response = event.get("response") if isinstance(event.get("response"), dict) else {}
                    raise error_from_payload(response, request_id=request_id)
                elif kind == "response.incomplete":
                    response = event.get("response") if isinstance(event.get("response"), dict) else {}
                    details = response.get("incomplete_details") if isinstance(response, dict) else None
                    reason = details.get("reason") if isinstance(details, dict) else None
                    raise ChatGptPlanError(
                        f"ChatGPT stopped before finishing the answer ({reason or 'incomplete'}).",
                        code=reason if isinstance(reason, str) else None,
                        request_id=request_id,
                    )
                elif kind == "error":
                    raise error_from_payload({"error": event}, request_id=request_id)
    raise ChatGptPlanError("The ChatGPT response stream ended before the answer was complete.")


async def list_models(
    access_token: str, *, transport: httpx.AsyncBaseTransport | None = None
) -> list[dict[str, str]]:
    """Models the signed-in account may use, in the server's order."""
    async with httpx.AsyncClient(timeout=15.0, transport=transport) as http:
        res = await http.get(MODELS_URL, headers={"Authorization": f"Bearer {access_token}"})
    if res.status_code != 200:
        raise error_from_response(res, res.content)
    payload = res.json()
    entries = payload.get("models") if isinstance(payload, dict) else None
    models: list[dict[str, str]] = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict) or entry.get("visibility") != "list":
            continue
        slug = entry.get("slug")
        if isinstance(slug, str) and slug:
            name = entry.get("display_name")
            models.append({"slug": slug, "name": name if isinstance(name, str) and name else slug})
    return models
