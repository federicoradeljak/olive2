"""The ChatGPT plan through the Codex sign-in as an LLM provider adapter for ``LlmService``."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from ..chatgpt_plan.provider import ChatGptPlanProvider
from .auth import ChatGptCodexAuth, get_chatgpt_codex_auth
from .client import FALLBACK_MODELS, list_models, stream_response

PROVIDER_ID = "chatgpt-codex"
PROVIDER_NAME = "ChatGPT plan (Codex)"


class ChatGptCodexProvider(ChatGptPlanProvider):
    """Signs requests with the Codex credentials and the ChatGPT account id."""

    id = PROVIDER_ID
    name = PROVIDER_NAME
    fallback_models = FALLBACK_MODELS

    def __init__(self, auth: ChatGptCodexAuth) -> None:
        super().__init__(auth)
        self.auth: ChatGptCodexAuth = auth

    async def fetch_models(self) -> list[dict[str, str]]:
        token, account_id = await self.auth.get_credentials()
        return await list_models(token, account_id, transport=self.auth.transport)

    async def stream(
        self,
        *,
        model: str,
        instructions: str | None,
        messages: Sequence[dict[str, str]],
        on_delta: Callable[[str], Any] | None = None,
    ) -> tuple[str, dict[str, int] | None]:
        token, account_id = await self.auth.get_credentials()
        return await stream_response(
            token,
            account_id,
            model=model,
            instructions=instructions,
            messages=messages,
            on_delta=on_delta,
            transport=self.auth.transport,
        )

    def login_error(self, status: dict[str, Any]) -> str | None:
        return None


def build_provider(config_dir: str) -> ChatGptCodexProvider:
    return ChatGptCodexProvider(get_chatgpt_codex_auth(config_dir))
