"""The ChatGPT plan as an LLM provider adapter for ``LlmService``."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from .auth import ChatGptPlanAuth, get_chatgpt_plan_auth
from .client import list_models, stream_response

PROVIDER_ID = "chatgpt-plan"
PROVIDER_NAME = "ChatGPT plan"


class ChatGptPlanProvider:
    """Signs requests with the plan credentials and talks to the plan Responses API.

    Wraps an auth from the per-file registry and never builds its own, so every
    ``LlmService`` on the same config dir shares one refresh lock.
    """

    id = PROVIDER_ID
    name = PROVIDER_NAME
    # Shown when the live model list is unavailable and nothing is cached.
    fallback_models: Sequence[dict[str, str]] = ()

    def __init__(self, auth: ChatGptPlanAuth) -> None:
        self.auth = auth

    def is_usable(self) -> bool:
        return self.auth.is_usable()

    async def fetch_models(self) -> list[dict[str, str]]:
        token = await self.auth.get_access_token()
        return await list_models(token, transport=self.auth.transport)

    async def stream(
        self,
        *,
        model: str,
        instructions: str | None,
        messages: Sequence[dict[str, str]],
        on_delta: Callable[[str], Any] | None = None,
    ) -> tuple[str, dict[str, int] | None]:
        token = await self.auth.get_access_token()
        return await stream_response(
            token,
            model=model,
            instructions=instructions,
            messages=messages,
            on_delta=on_delta,
            transport=self.auth.transport,
        )

    def login_error(self, status: dict[str, Any]) -> str | None:
        """Why a completed sign-in still cannot be used, if it cannot."""
        if status["planEnabled"]:
            return None
        return (
            "Signed in, but ChatGPT plan usage was not allowed. "
            "Connect again and tick the option to use your ChatGPT plan in Olive."
        )


def build_provider(config_dir: str) -> ChatGptPlanProvider:
    return ChatGptPlanProvider(get_chatgpt_plan_auth(config_dir))
