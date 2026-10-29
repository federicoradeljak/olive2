"""Use the signed-in user's ChatGPT plan (Go/Plus/Pro) as an LLM provider."""

from .auth import TOKENS_FILENAME, ChatGptPlanAuth, get_chatgpt_plan_auth
from .client import list_models, stream_response
from .errors import ChatGptPlanError

PROVIDER_ID = "chatgpt-plan"
PROVIDER_NAME = "ChatGPT plan"

__all__ = [
    "PROVIDER_ID",
    "PROVIDER_NAME",
    "TOKENS_FILENAME",
    "ChatGptPlanAuth",
    "ChatGptPlanError",
    "get_chatgpt_plan_auth",
    "list_models",
    "stream_response",
]
