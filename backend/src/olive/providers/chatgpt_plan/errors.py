"""Errors raised by the ChatGPT plan provider, with user-facing messages."""

from __future__ import annotations

import json
from typing import Any

import httpx

# Structured Responses error codes documented for ChatGPT plan usage.
_CODE_MESSAGES: dict[str, str] = {
    "subscription_sharing_usage_limit_exceeded": (
        "You've reached the ChatGPT plan usage limit for Olive. "
        "Check ChatGPT → Settings → Usage, or pick another AI provider."
    ),
    "subscription_sharing_usage_unavailable": (
        "ChatGPT plan usage is temporarily unavailable. Try again in a few minutes."
    ),
    "subscription_sharing_user_not_eligible": (
        "This ChatGPT account or workspace can't use its plan in Olive."
    ),
    "subscription_sharing_invalid_user": (
        "ChatGPT rejected the saved sign-in. Reconnect ChatGPT in Settings → AI models."
    ),
}


class ChatGptPlanError(RuntimeError):
    """A ChatGPT plan request failed; ``str(exc)`` is safe to show to the user."""

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status: int | None = None,
        request_id: str | None = None,
        reauth_required: bool = False,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.reauth_required = reauth_required


def message_for_code(code: str | None, fallback: str) -> str:
    return _CODE_MESSAGES.get(code or "", fallback)


def error_from_payload(
    payload: Any, *, status: int | None = None, request_id: str | None = None
) -> ChatGptPlanError:
    """Build an error from a Responses error object or an admission ``{"detail": ...}`` body."""
    code: str | None = None
    detail: str | None = None
    if isinstance(payload, dict):
        err = payload.get("error")
        if isinstance(err, dict):
            code = err.get("code") if isinstance(err.get("code"), str) else None
            detail = err.get("message") if isinstance(err.get("message"), str) else None
        elif isinstance(err, str):
            detail = err
        if detail is None and isinstance(payload.get("detail"), str):
            detail = payload["detail"]
        if code is None and isinstance(payload.get("code"), str):
            code = payload["code"]
        if detail is None and isinstance(payload.get("message"), str):
            detail = payload["message"]

    fallback = detail or (f"ChatGPT request failed (HTTP {status})" if status else "ChatGPT request failed")
    message = message_for_code(code, fallback)
    if code not in _CODE_MESSAGES and request_id:
        message = f"{message} (request {request_id})"
    return ChatGptPlanError(
        message,
        code=code,
        status=status,
        request_id=request_id,
        reauth_required=code == "subscription_sharing_invalid_user",
    )


def error_from_response(res: httpx.Response, body: bytes) -> ChatGptPlanError:
    try:
        payload: Any = json.loads(body.decode("utf-8") or "null")
    except Exception:
        payload = {"detail": body.decode("utf-8", errors="replace")[:300] or None}
    return error_from_payload(payload, status=res.status_code, request_id=res.headers.get("x-request-id"))
