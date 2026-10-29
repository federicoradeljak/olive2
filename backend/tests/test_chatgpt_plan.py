"""ChatGPT plan provider: sign-in, token refresh and Responses streaming."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import stat
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from olive.providers.chatgpt_plan import ChatGptPlanAuth, ChatGptPlanError, list_models, stream_response
from olive.providers.chatgpt_plan.auth import (
    DYNAMIC_CLIENT_ID,
    ISSUER,
    PLAN_SCOPE,
    REDIRECT_URI,
    RESOURCE,
    SCOPES,
    TOKEN_URL,
)

CLIENT_ID = "oaiapp_test123"


def _id_token(**overrides: Any) -> str:
    claims = {
        "iss": ISSUER,
        "aud": CLIENT_ID,
        "sub": "user-1",
        "email": "ana@example.com",
        "exp": int(time.time()) + 3600,
        **overrides,
    }

    def enc(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    return f"{enc({'alg': 'RS256'})}.{enc(claims)}.sig"


def _token_response(nonce: str | None, scope: str = SCOPES, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "access_token": "access-1",
        "refresh_token": "refresh-1",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": scope,
        **extra,
    }
    if nonce is not None:
        body["id_token"] = _id_token(nonce=nonce)
    return body


def _callback(start: dict[str, Any], *, client_id: str | None = CLIENT_ID) -> str:
    url = f"{REDIRECT_URI}?code=the-code&state={start['state']}"
    return f"{url}&client_id={client_id}" if client_id else url


async def _signed_in(tmp_path: Path, scope: str = SCOPES) -> tuple[ChatGptPlanAuth, list[dict[str, str]]]:
    """An auth object after a successful first sign-in; returns it with the recorded token requests."""
    requests: list[dict[str, str]] = []
    state: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
        requests.append(form)
        return httpx.Response(200, json=_token_response(state["nonce"], scope=scope))

    auth = ChatGptPlanAuth(str(tmp_path / "chatgpt-plan-tokens.json"), transport=httpx.MockTransport(handler))
    start = auth.start_login()
    state["nonce"] = start["nonce"]
    await auth.complete_login(start, _callback(start))
    return auth, requests


def test_first_login_url_registers_a_dynamic_client(tmp_path: Path) -> None:
    auth = ChatGptPlanAuth(str(tmp_path / "tokens.json"))
    start = auth.start_login()
    url = urlparse(start["authUrl"])
    params = {k: v[0] for k, v in parse_qs(url.query).items()}

    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://auth.openai.com/api/accounts/authorize"
    assert params["client_id"] == DYNAMIC_CLIENT_ID
    assert params["agent_name_hint"] == "Olive"
    assert params["ext_agent_host_id"].startswith("urn:uuid:")
    assert params["redirect_uri"] == REDIRECT_URI
    assert params["scope"] == SCOPES
    assert params["resource"] == RESOURCE
    assert params["code_challenge_method"] == "S256"
    assert params["state"] == start["state"] and params["nonce"] == start["nonce"]
    assert "id_token_hint" not in params

    # The host id is persisted and reused.
    again = parse_qs(urlparse(auth.start_login()["authUrl"]).query)
    assert again["ext_agent_host_id"][0] == params["ext_agent_host_id"]


async def test_complete_login_saves_owner_only_credentials(tmp_path: Path) -> None:
    auth, requests = await _signed_in(tmp_path)

    assert requests[0]["grant_type"] == "authorization_code"
    assert requests[0]["client_id"] == CLIENT_ID
    assert requests[0]["redirect_uri"] == REDIRECT_URI
    assert requests[0]["resource"] == RESOURCE
    assert requests[0]["code"] == "the-code"
    assert requests[0]["code_verifier"]

    status = auth.status()
    assert status["connected"] and status["planEnabled"]
    assert status["email"] == "ana@example.com"
    saved = json.loads(Path(auth.tokens_path).read_text())
    assert saved["clientId"] == CLIENT_ID
    assert saved["account"]["refreshToken"] == "refresh-1"
    if os.name != "nt":
        assert stat.S_IMODE(Path(auth.tokens_path).stat().st_mode) == 0o600


async def test_returning_login_reuses_issued_client(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path)
    params = parse_qs(urlparse(auth.start_login()["authUrl"]).query)
    assert params["client_id"] == [CLIENT_ID]
    assert "agent_name_hint" not in params
    assert "id_token_hint" in params
    assert params["login_hint"] == ["ana@example.com"]


@pytest.mark.parametrize(
    ("pasted", "message"),
    [
        (f"{REDIRECT_URI}?error=access_denied&state=x", "cancelled"),
        (f"{REDIRECT_URI}?state=x", "no sign-in code"),
        (f"{REDIRECT_URI}?code=c&state=other&client_id={CLIENT_ID}", "different sign-in"),
    ],
)
async def test_complete_login_rejects_bad_callbacks(tmp_path: Path, pasted: str, message: str) -> None:
    auth = ChatGptPlanAuth(str(tmp_path / "tokens.json"))
    start = auth.start_login()
    with pytest.raises(ChatGptPlanError, match=message):
        await auth.complete_login(start, pasted.replace("state=x", f"state={start['state']}"))


async def test_first_login_requires_the_issued_client_id(tmp_path: Path) -> None:
    auth = ChatGptPlanAuth(str(tmp_path / "tokens.json"))
    start = auth.start_login()
    with pytest.raises(ChatGptPlanError, match="client_id"):
        await auth.complete_login(start, _callback(start, client_id=None))


async def test_complete_login_checks_the_id_token_nonce(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda _req: httpx.Response(200, json=_token_response("wrong-nonce")))
    auth = ChatGptPlanAuth(str(tmp_path / "tokens.json"), transport=transport)
    start = auth.start_login()
    with pytest.raises(ChatGptPlanError, match="nonce"):
        await auth.complete_login(start, _callback(start))
    assert not auth.status()["connected"]


async def test_missing_plan_scope_blocks_inference(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path, scope="openid profile email offline_access")
    status = auth.status()
    assert status["connected"] and not status["planEnabled"]
    with pytest.raises(ChatGptPlanError, match="not enabled") as exc:
        await auth.get_access_token()
    assert exc.value.reauth_required


async def test_refreshes_expiring_token_once_under_concurrency(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path)
    data = json.loads(Path(auth.tokens_path).read_text())
    data["account"]["expiresAt"] = int(time.time() * 1000) + 1000
    Path(auth.tokens_path).write_text(json.dumps(data))

    refreshes: list[dict[str, str]] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        assert str(req.url) == TOKEN_URL
        refreshes.append({k: v[0] for k, v in parse_qs(req.content.decode()).items()})
        await asyncio.sleep(0.01)
        return httpx.Response(
            200, json={"access_token": "access-2", "refresh_token": "refresh-2", "expires_in": 3600}
        )

    auth.transport = httpx.MockTransport(handler)
    tokens = await asyncio.gather(auth.get_access_token(), auth.get_access_token())

    assert tokens == ["access-2", "access-2"]
    assert len(refreshes) == 1
    assert refreshes[0]["grant_type"] == "refresh_token"
    assert refreshes[0]["client_id"] == CLIENT_ID
    assert refreshes[0]["refresh_token"] == "refresh-1"
    saved = json.loads(Path(auth.tokens_path).read_text())["account"]
    assert saved["refreshToken"] == "refresh-2"
    assert PLAN_SCOPE in saved["scopes"]


async def test_terminal_refresh_error_disconnects_but_keeps_registration(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path)
    data = json.loads(Path(auth.tokens_path).read_text())
    data["account"]["expiresAt"] = 0
    Path(auth.tokens_path).write_text(json.dumps(data))
    auth.transport = httpx.MockTransport(lambda _req: httpx.Response(400, json={"error": "invalid_grant"}))

    with pytest.raises(ChatGptPlanError, match="Reconnect") as exc:
        await auth.get_access_token()
    assert exc.value.reauth_required
    assert not auth.status()["connected"]
    assert json.loads(Path(auth.tokens_path).read_text())["clientId"] == CLIENT_ID


async def test_transient_refresh_error_keeps_tokens(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path)
    data = json.loads(Path(auth.tokens_path).read_text())
    data["account"]["expiresAt"] = 0
    Path(auth.tokens_path).write_text(json.dumps(data))
    auth.transport = httpx.MockTransport(lambda _req: httpx.Response(503, text="unavailable"))

    with pytest.raises(ChatGptPlanError):
        await auth.get_access_token()
    assert auth.status()["connected"]


async def test_logout_revokes_and_forgets_tokens(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path)
    revoked: list[dict[str, str]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.method == "GET":
            return httpx.Response(200, json={"revocation_endpoint": "https://auth.openai.com/revoke"})
        revoked.append({k: v[0] for k, v in parse_qs(req.content.decode()).items()})
        return httpx.Response(200)

    auth.transport = httpx.MockTransport(handler)
    assert await auth.logout() == {"revoked": True}
    assert revoked == [{"token": "refresh-1", "token_type_hint": "refresh_token", "client_id": CLIENT_ID}]
    assert not auth.status()["connected"]


def _sse(*events: dict[str, Any]) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


async def test_stream_response_yields_deltas_and_usage() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["auth"] = req.headers["authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(
            200,
            content=_sse(
                {"type": "response.created"},
                {"type": "response.output_text.delta", "delta": "Hel"},
                {"type": "response.output_text.delta", "delta": "lo"},
                {
                    "type": "response.completed",
                    "response": {"usage": {"input_tokens": 10, "output_tokens": 2, "total_tokens": 12}},
                },
            ),
        )

    deltas: list[str] = []
    text, usage = await stream_response(
        "tok",
        model="gpt-test",
        instructions="Be brief.",
        messages=[{"role": "user", "content": "hi"}],
        on_delta=deltas.append,
        transport=httpx.MockTransport(handler),
    )

    assert text == "Hello" and deltas == ["Hel", "lo"]
    assert usage == {"input": 10, "output": 2, "total": 12}
    assert seen["auth"] == "Bearer tok"
    assert seen["body"] == {
        "model": "gpt-test",
        "input": [{"role": "user", "content": "hi"}],
        "store": False,
        "stream": True,
        "instructions": "Be brief.",
    }


async def test_stream_response_maps_usage_limit_failure() -> None:
    transport = httpx.MockTransport(
        lambda _req: httpx.Response(
            200,
            content=_sse(
                {"type": "response.output_text.delta", "delta": "x"},
                {
                    "type": "response.failed",
                    "response": {
                        "error": {"code": "subscription_sharing_usage_limit_exceeded", "message": "limit"}
                    },
                },
            ),
        )
    )
    with pytest.raises(ChatGptPlanError, match="usage limit") as exc:
        await stream_response("tok", model="m", instructions=None, messages=[], transport=transport)
    assert exc.value.code == "subscription_sharing_usage_limit_exceeded"


async def test_stream_response_requires_completed_event() -> None:
    transport = httpx.MockTransport(
        lambda _req: httpx.Response(200, content=_sse({"type": "response.output_text.delta", "delta": "x"}))
    )
    with pytest.raises(ChatGptPlanError, match="ended before"):
        await stream_response("tok", model="m", instructions=None, messages=[], transport=transport)


async def test_stream_response_maps_admission_errors() -> None:
    transport = httpx.MockTransport(
        lambda _req: httpx.Response(
            403,
            json={"error": {"code": "subscription_sharing_user_not_eligible", "message": "nope"}},
            headers={"x-request-id": "req-1"},
        )
    )
    with pytest.raises(ChatGptPlanError, match="can't use its plan") as exc:
        await stream_response("tok", model="m", instructions=None, messages=[], transport=transport)
    assert exc.value.status == 403 and exc.value.request_id == "req-1"


async def test_list_models_keeps_listed_entries_in_server_order() -> None:
    transport = httpx.MockTransport(
        lambda _req: httpx.Response(
            200,
            json={
                "models": [
                    {"slug": "b-model", "display_name": "B", "visibility": "list"},
                    {"slug": "hidden", "display_name": "H", "visibility": "hide"},
                    {"slug": "a-model", "display_name": "A", "visibility": "list"},
                ]
            },
        )
    )
    assert await list_models("tok", transport=transport) == [
        {"slug": "b-model", "name": "B"},
        {"slug": "a-model", "name": "A"},
    ]
