"""Responses calls to the Codex backend, billed to the user's ChatGPT plan."""

from __future__ import annotations

import uuid
from collections.abc import Callable, Sequence
from typing import Any

import httpx

from ..chatgpt_plan.client import STREAM_TIMEOUT, consume_response_stream, parse_models
from ..chatgpt_plan.errors import error_from_response
from .auth import ORIGINATOR

CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"
RESPONSES_URL = f"{CODEX_BASE_URL}/responses"
MODELS_URL = f"{CODEX_BASE_URL}/models"
# The models endpoint filters by client version; this matches a recent Codex CLI.
CLIENT_VERSION = "0.158.0"
# Used when the models endpoint is unavailable.
FALLBACK_MODELS = [
    {"slug": "gpt-5.5", "name": "GPT-5.5"},
    {"slug": "gpt-5.4", "name": "GPT-5.4"},
    {"slug": "gpt-5.4-mini", "name": "GPT-5.4 mini"},
]
# The Codex backend requires instructions on every request.
DEFAULT_INSTRUCTIONS = "You are a helpful assistant."


def _headers(access_token: str, account_id: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "ChatGPT-Account-Id": account_id,
        "originator": ORIGINATOR,
    }


def to_input(messages: Sequence[dict[str, str]]) -> list[dict[str, Any]]:
    """Chat messages as typed Responses input items (system turns become developer turns)."""
    items: list[dict[str, Any]] = []
    for m in messages:
        role = m["role"]
        if role == "assistant":
            items.append({"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": m["content"]}]})
        else:
            items.append(
                {
                    "type": "message",
                    "role": "developer" if role == "system" else "user",
                    "content": [{"type": "input_text", "text": m["content"]}],
                }
            )
    return items


async def stream_response(
    access_token: str,
    account_id: str,
    *,
    model: str,
    instructions: str | None,
    messages: Sequence[dict[str, str]],
    on_delta: Callable[[str], Any] | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[str, dict[str, int] | None]:
    """Run one streamed Codex Responses request; returns the full text and token usage.

    Like plan usage, it must stream with ``store: false`` and takes no
    sampling fields.
    """
    body: dict[str, Any] = {
        "model": model,
        "instructions": instructions or DEFAULT_INSTRUCTIONS,
        "input": to_input(messages),
        "store": False,
        "stream": True,
    }
    headers = {
        **_headers(access_token, account_id),
        "OpenAI-Beta": "responses=experimental",
        "session_id": str(uuid.uuid4()),
        "Accept": "text/event-stream",
    }
    async with httpx.AsyncClient(timeout=STREAM_TIMEOUT, transport=transport) as http:
        async with http.stream("POST", RESPONSES_URL, headers=headers, json=body) as res:
            return await consume_response_stream(res, on_delta)


async def list_models(
    access_token: str, account_id: str, *, transport: httpx.AsyncBaseTransport | None = None
) -> list[dict[str, str]]:
    """Models the signed-in account may use with Codex, in the server's order."""
    async with httpx.AsyncClient(timeout=15.0, transport=transport) as http:
        res = await http.get(
            MODELS_URL,
            params={"client_version": CLIENT_VERSION},
            headers=_headers(access_token, account_id),
        )
    if res.status_code != 200:
        raise error_from_response(res, res.content)
    return parse_models(res.json()) or list(FALLBACK_MODELS)
