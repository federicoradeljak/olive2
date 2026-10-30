"""ChatGPT via the Codex sign-in: login, token refresh and Codex Responses streaming."""

from __future__ import annotations

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

from olive.providers.chatgpt_codex import ChatGptCodexAuth, list_models, stream_response
from olive.providers.chatgpt_codex.auth import AUTH_CLAIM, CLIENT_ID, REDIRECT_URI, SCOPES, TOKEN_URL
from olive.providers.chatgpt_codex.client import FALLBACK_MODELS, MODELS_URL, RESPONSES_URL
from olive.providers.chatgpt_plan import ChatGptPlanError
from olive.providers.chatgpt_plan.auth import ISSUER


def _jwt(claims: dict[str, Any]) -> str:
    def enc(obj: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    return f"{enc({'alg': 'RS256'})}.{enc(claims)}.sig"


def _id_token(**overrides: Any) -> str:
    return _jwt(
        {
            "iss": ISSUER,
            "aud": CLIENT_ID,
            "sub": "user-1",
            "email": "ana@example.com",
            "exp": int(time.time()) + 3600,
            AUTH_CLAIM: {"chatgpt_account_id": "acct-1", "chatgpt_plan_type": "enterprise"},
            **overrides,
        }
    )


def _token_response(**extra: Any) -> dict[str, Any]:
    return {
        "access_token": "access-1",
        "refresh_token": "refresh-1",
        "id_token": _id_token(),
        "token_type": "Bearer",
        "expires_in": 3600,
        **extra,
    }


def _form(req: httpx.Request) -> dict[str, str]:
    return {k: v[0] for k, v in parse_qs(req.content.decode()).items()}


async def _signed_in(tmp_path: Path) -> tuple[ChatGptCodexAuth, list[dict[str, str]]]:
    requests: list[dict[str, str]] = []

    def handler(req: httpx.Request) -> httpx.Response:
        requests.append(_form(req))
        return httpx.Response(200, json=_token_response())

    auth = ChatGptCodexAuth(str(tmp_path / "chatgpt-codex-tokens.json"), transport=httpx.MockTransport(handler))
    start = auth.start_login()
    await auth.complete_login(start, f"{REDIRECT_URI}?code=the-code&state={start['state']}")
    return auth, requests


def test_login_url_uses_the_codex_client(tmp_path: Path) -> None:
    auth = ChatGptCodexAuth(str(tmp_path / "tokens.json"))
    start = auth.start_login()
    url = urlparse(start["authUrl"])
    params = {k: v[0] for k, v in parse_qs(url.query).items()}

    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://auth.openai.com/oauth/authorize"
    assert params["client_id"] == CLIENT_ID
    assert params["redirect_uri"] == REDIRECT_URI
    assert params["scope"] == SCOPES
    assert params["code_challenge_method"] == "S256"
    assert params["codex_cli_simplified_flow"] == "true"
    assert params["id_token_add_organizations"] == "true"
    assert params["originator"] == "olive"
    assert params["state"] == start["state"]


async def test_complete_login_saves_account_and_owner_only_credentials(tmp_path: Path) -> None:
    auth, requests = await _signed_in(tmp_path)

    assert requests[0] == {
        "grant_type": "authorization_code",
        "client_id": CLIENT_ID,
        "code": "the-code",
        "code_verifier": requests[0]["code_verifier"],
        "redirect_uri": REDIRECT_URI,
    }
    assert auth.status()["connected"] and auth.status()["planType"] == "enterprise"
    assert auth.status()["email"] == "ana@example.com"
    assert auth.is_usable()
    saved = json.loads(Path(auth.tokens_path).read_text())
    assert saved["account"]["accountId"] == "acct-1"
    if os.name != "nt":
        assert stat.S_IMODE(Path(auth.tokens_path).stat().st_mode) == 0o600
    assert await auth.get_credentials() == ("access-1", "acct-1")


async def test_complete_login_rejects_wrong_state_and_missing_account(tmp_path: Path) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_token_response(id_token=_id_token(**{AUTH_CLAIM: {}})))

    auth = ChatGptCodexAuth(str(tmp_path / "t.json"), transport=httpx.MockTransport(handler))
    start = auth.start_login()
    with pytest.raises(ChatGptPlanError, match="different sign-in"):
        await auth.complete_login(start, f"{REDIRECT_URI}?code=c&state=other")
    with pytest.raises(ChatGptPlanError, match="which account"):
        await auth.complete_login(start, f"{REDIRECT_URI}?code=c&state={start['state']}")
    assert not auth.is_usable()


async def test_refreshes_expiring_token(tmp_path: Path) -> None:
    auth, requests = await _signed_in(tmp_path)
    data = json.loads(Path(auth.tokens_path).read_text())
    data["account"]["expiresAt"] = 0
    Path(auth.tokens_path).write_text(json.dumps(data))
    auth.transport = httpx.MockTransport(
        lambda req: (requests.append(_form(req)), httpx.Response(200, json={"access_token": "access-2", "expires_in": 3600}))[1]
    )

    assert await auth.get_credentials() == ("access-2", "acct-1")
    assert requests[-1] == {"grant_type": "refresh_token", "client_id": CLIENT_ID, "refresh_token": "refresh-1"}
    assert json.loads(Path(auth.tokens_path).read_text())["account"]["refreshToken"] == "refresh-1"


async def test_terminal_refresh_error_disconnects(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path)
    data = json.loads(Path(auth.tokens_path).read_text())
    data["account"]["expiresAt"] = 0
    Path(auth.tokens_path).write_text(json.dumps(data))
    auth.transport = httpx.MockTransport(lambda _req: httpx.Response(400, json={"error": "invalid_grant"}))

    with pytest.raises(ChatGptPlanError, match="Reconnect") as exc:
        await auth.get_credentials()
    assert exc.value.reauth_required
    assert not auth.status()["connected"]


async def test_logout_forgets_tokens(tmp_path: Path) -> None:
    auth, _ = await _signed_in(tmp_path)
    assert await auth.logout() == {"revoked": False}
    assert not auth.status()["connected"]
    with pytest.raises(ChatGptPlanError, match="not connected"):
        await auth.get_credentials()


def _sse(*events: dict[str, Any]) -> bytes:
    return "".join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events).encode()


def _codex_api(seen: list[httpx.Request], models: httpx.Response | None = None) -> httpx.MockTransport:
    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path.endswith("/models"):
            return models or httpx.Response(
                200, json={"models": [{"slug": "gpt-codex", "display_name": "GPT Codex", "visibility": "list"}]}
            )
        return httpx.Response(
            200,
            content=_sse(
                {"type": "response.output_text.delta", "delta": "Fri"},
                {"type": "response.output_text.delta", "delta": "day."},
                {
                    "type": "response.completed",
                    "response": {"usage": {"input_tokens": 7, "output_tokens": 2, "total_tokens": 9}},
                },
            ),
        )

    return httpx.MockTransport(handler)


async def test_stream_response_sends_codex_headers_and_typed_input() -> None:
    seen: list[httpx.Request] = []
    deltas: list[str] = []
    text, usage = await stream_response(
        "tok",
        "acct-1",
        model="gpt-codex",
        instructions=None,
        messages=[
            {"role": "system", "content": "ctx"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "hello"},
        ],
        on_delta=deltas.append,
        transport=_codex_api(seen),
    )

    assert (text, deltas) == ("Friday.", ["Fri", "day."])
    assert usage == {"input": 7, "output": 2, "total": 9}
    req = seen[0]
    assert str(req.url) == RESPONSES_URL
    assert req.headers["authorization"] == "Bearer tok"
    assert req.headers["chatgpt-account-id"] == "acct-1"
    assert req.headers["originator"] == "olive"
    assert req.headers["session_id"]
    body = json.loads(req.content)
    assert body["instructions"]  # the Codex backend requires instructions
    assert body["store"] is False and body["stream"] is True
    assert body["input"] == [
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "ctx"}]},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "hello"}]},
    ]


async def test_stream_response_maps_http_errors() -> None:
    transport = httpx.MockTransport(lambda _req: httpx.Response(429, json={"detail": "Too many requests"}))
    with pytest.raises(ChatGptPlanError, match="Too many requests"):
        await stream_response("tok", "acct-1", model="m", instructions="x", messages=[], transport=transport)


async def test_list_models_reads_codex_catalog_and_falls_back_when_empty() -> None:
    seen: list[httpx.Request] = []
    assert await list_models("tok", "acct-1", transport=_codex_api(seen)) == [{"slug": "gpt-codex", "name": "GPT Codex"}]
    assert str(seen[0].url).startswith(MODELS_URL) and "client_version" in seen[0].url.params
    assert seen[0].headers["chatgpt-account-id"] == "acct-1"

    empty = _codex_api([], models=httpx.Response(200, json={"models": []}))
    assert await list_models("tok", "acct-1", transport=empty) == FALLBACK_MODELS


async def test_llm_service_routes_codex_without_api_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import any_llm

    from olive.db import create_db
    from olive.services.llm import LlmService

    async def no_any_llm(**_kwargs: Any) -> None:
        raise AssertionError("any_llm must not be called for ChatGPT (Codex)")

    monkeypatch.setattr(any_llm, "acompletion", no_any_llm)
    await _signed_in(tmp_path)
    handle = create_db(":memory:")
    service = LlmService(db=handle.engine, config_dir=str(tmp_path))
    seen: list[httpx.Request] = []
    service.account_provider("chatgpt-codex").auth.transport = _codex_api(seen)

    providers = {p.id: p for p in await service.list_providers()}
    assert providers["chatgpt-codex"].isConfigured
    assert providers["chatgpt-codex"].name == "ChatGPT plan (Codex)"
    assert not providers["chatgpt-plan"].isConfigured
    configured = await service.list_models({"configured": True, "provider": "chatgpt-codex"})
    assert [(m.id, m.source) for m in configured] == [("gpt-codex", "account")]

    deltas: list[str] = []
    res = await service.stream_text(
        {
            "provider": "chatgpt-codex",
            "model": "gpt-codex",
            "systemPrompt": "Use the meeting.",
            "prompt": "When?",
            "temperature": 0.2,
            "messages": [{"role": "user", "content": "When?"}],
        },
        deltas.append,
    )
    assert (res.text, res.provider, res.model) == ("Friday.", "chatgpt-codex", "gpt-codex")
    assert res.usage.totalTokens == 9 and res.usage.cost == 0.0
    body = json.loads(seen[-1].content)
    assert body["instructions"] == "Use the meeting." and "temperature" not in body
    handle.engine.dispose()


async def test_codex_models_fall_back_when_the_catalog_fails(tmp_path: Path) -> None:
    from olive.db import create_db
    from olive.services.llm import LlmService

    await _signed_in(tmp_path)
    handle = create_db(":memory:")
    service = LlmService(db=handle.engine, config_dir=str(tmp_path))
    service.account_provider("chatgpt-codex").auth.transport = _codex_api([], models=httpx.Response(500, json={"detail": "down"}))

    models = await service.list_models({"provider": "chatgpt-codex"})
    assert {m.id for m in models} == {m["slug"] for m in FALLBACK_MODELS}
    handle.engine.dispose()


async def test_codex_provider_is_listed_but_unusable_until_connected(tmp_path: Path) -> None:
    from olive.db import create_db
    from olive.services.llm import LlmService

    handle = create_db(":memory:")
    service = LlmService(db=handle.engine, config_dir=str(tmp_path))

    codex = next(p for p in await service.list_providers() if p.id == "chatgpt-codex")
    assert not codex.isConfigured and codex.modelCount == 0
    with pytest.raises(ChatGptPlanError, match="not connected"):
        await service.generate_text({"provider": "chatgpt-codex", "model": "gpt-codex", "prompt": "hi"})
    handle.engine.dispose()


def test_chatgpt_codex_connect_api(tmp_path: Path) -> None:
    from fastapi.testclient import TestClient

    from olive.app import create_app
    from olive.db import create_db
    from olive.providers.chatgpt_codex import get_chatgpt_codex_auth

    handle = create_db(":memory:")
    client = TestClient(create_app({"db": handle.engine, "configDir": str(tmp_path)}))
    auth = get_chatgpt_codex_auth(str(tmp_path))
    auth.transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json=_token_response()) if str(req.url) == TOKEN_URL else httpx.Response(404)
    )

    assert client.get("/api/llm/chatgpt-codex/status").json()["connected"] is False

    start = client.post("/api/llm/chatgpt-codex/auth/start").json()
    assert set(start) == {"authUrl", "sessionId"}
    state = parse_qs(urlparse(start["authUrl"]).query)["state"][0]

    bad = client.post(
        "/api/llm/chatgpt-codex/auth/complete",
        json={"sessionId": start["sessionId"], "pastedUrlOrCode": f"{REDIRECT_URI}?code=c&state=wrong"},
    )
    assert bad.status_code == 400

    pasted = f"{REDIRECT_URI}?code=c&state={state}"
    done = client.post(
        "/api/llm/chatgpt-codex/auth/complete", json={"sessionId": start["sessionId"], "pastedUrlOrCode": pasted}
    )
    assert done.status_code == 200, done.text
    assert done.json()["account"]["email"] == "ana@example.com"
    reused = client.post(
        "/api/llm/chatgpt-codex/auth/complete", json={"sessionId": start["sessionId"], "pastedUrlOrCode": pasted}
    )
    assert reused.status_code == 400

    cfg = client.post("/api/llm/config", json={"chatProvider": "chatgpt-codex", "chatModel": "gpt-codex"})
    assert cfg.status_code == 200
    assert client.get("/api/llm/config").json()["chatProvider"] == "chatgpt-codex"

    assert client.post("/api/llm/chatgpt-codex/logout").json() == {"status": "disconnected", "revoked": False}
    assert client.get("/api/llm/chatgpt-codex/status").json()["connected"] is False
    handle.engine.dispose()
