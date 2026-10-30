"""Sign in with ChatGPT (plan usage) for open-source, self-hosted apps.

Implements the dynamic-registration OAuth flow from
https://developers.openai.com/siwc/token-sharing-open-source. Olive usually
runs on a remote server, so the loopback callback never reaches it: the user
copies the ``127.0.0.1`` address the browser lands on and pastes it back (the
same flow as the Plaud login).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import sys
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from .errors import ChatGptPlanError

AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize"
TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
OPENID_CONFIGURATION_URL = "https://auth.openai.com/.well-known/openid-configuration"
ISSUER = "https://auth.openai.com"
REDIRECT_URI = "http://127.0.0.1:1455/auth/callback"
RESOURCE = "https://api.openai.com/v1"
PLAN_SCOPE = "chatgpt.tokens.use.direct"
SCOPES = f"openid profile email offline_access resource.invoke {PLAN_SCOPE}"
DYNAMIC_CLIENT_ID = "dynamic_agent_client"
AGENT_NAME = "Olive"
TOKENS_FILENAME = "chatgpt-plan-tokens.json"

# Refresh this long before the 1 h access token expires.
REFRESH_MARGIN_MS = 5 * 60 * 1000
# Refresh errors that mean the refresh token is gone for good.
TERMINAL_REFRESH_ERRORS = {
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _decode_jwt_claims(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise ChatGptPlanError("ChatGPT returned a malformed ID token.")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(padded))
    except Exception as exc:
        raise ChatGptPlanError("ChatGPT returned a malformed ID token.") from exc
    if not isinstance(claims, dict):
        raise ChatGptPlanError("ChatGPT returned a malformed ID token.")
    return claims


def validate_id_token(
    id_token: str, *, client_id: str, nonce: str | None, now_ms: int | None = None
) -> dict[str, Any]:
    """Check issuer, audience, nonce and expiry of an ID token.

    The signature is not verified: the token comes straight from the token
    endpoint over TLS, which OpenID Connect Core (§3.1.3.7) accepts in place
    of a signature check.
    """
    claims = _decode_jwt_claims(id_token)
    if claims.get("iss") != ISSUER:
        raise ChatGptPlanError("ChatGPT ID token has an unexpected issuer.")
    aud = claims.get("aud")
    audiences = aud if isinstance(aud, list) else [aud]
    if client_id not in audiences:
        raise ChatGptPlanError("ChatGPT ID token was issued for another client.")
    if nonce is not None and claims.get("nonce") != nonce:
        raise ChatGptPlanError("ChatGPT ID token nonce does not match this sign-in.")
    exp = claims.get("exp")
    now_s = (now_ms if now_ms is not None else _now_ms()) / 1000
    if isinstance(exp, (int, float)) and exp + 300 < now_s:
        raise ChatGptPlanError("ChatGPT ID token has expired.")
    if not isinstance(claims.get("sub"), str):
        raise ChatGptPlanError("ChatGPT ID token has no subject.")
    return claims


def parse_callback(pasted: str, *, redirect_uri: str = REDIRECT_URI) -> dict[str, str]:
    """Extract the callback query (``code``, ``state``, ``client_id``, ``error``) from a pasted URL."""
    raw = pasted.strip()
    if not raw:
        raise ChatGptPlanError("Paste the address your browser landed on after signing in.")
    query = urlparse(raw).query if "://" in raw else raw.lstrip("?")
    params = {k: v[0] for k, v in parse_qs(query).items() if v}
    if "error" in params:
        if params["error"] == "access_denied":
            raise ChatGptPlanError("ChatGPT sign-in was cancelled or plan usage was not allowed.")
        desc = params.get("error_description") or params["error"]
        raise ChatGptPlanError(f"ChatGPT sign-in failed: {desc}")
    if not params.get("code") or not params.get("state"):
        raise ChatGptPlanError(
            f"That address has no sign-in code. Copy the whole address starting with {redirect_uri}?code=…"
        )
    return params


class ChatGptPlanAuth:
    """Owns the ChatGPT plan credential file and keeps the access token fresh."""

    def __init__(self, tokens_path: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.tokens_path = tokens_path
        self.transport = transport
        self._lock = asyncio.Lock()
        self.models_cache: tuple[float, list[dict[str, str]]] | None = None

    # -- storage ------------------------------------------------------------

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(Path(self.tokens_path).read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save(self, data: dict[str, Any]) -> None:
        p = Path(self.tokens_path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(f".{p.name}.{uuid.uuid4().hex}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        if sys.platform != "win32":
            tmp.chmod(0o600)
        os.replace(tmp, p)

    def _host_id(self, data: dict[str, Any]) -> str:
        host_id = data.get("extAgentHostId")
        if not isinstance(host_id, str) or not host_id:
            host_id = f"urn:uuid:{uuid.uuid4()}"
            data["extAgentHostId"] = host_id
            self._save(data)
        return host_id

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=30.0, transport=self.transport)

    # -- sign-in --------------------------------------------------------------

    def start_login(self) -> dict[str, Any]:
        data = self._load()
        host_id = self._host_id(data)
        client_id = data.get("clientId") if isinstance(data.get("clientId"), str) else None
        account = data.get("account") if isinstance(data.get("account"), dict) else None

        verifier = _b64url(secrets.token_bytes(48))
        state = _b64url(secrets.token_bytes(24))
        nonce = _b64url(secrets.token_bytes(24))
        params: dict[str, str] = {
            "client_id": client_id or DYNAMIC_CLIENT_ID,
            "ext_agent_host_id": host_id,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "resource": RESOURCE,
            "state": state,
            "nonce": nonce,
            "code_challenge_method": "S256",
            "code_challenge": _b64url(hashlib.sha256(verifier.encode("ascii")).digest()),
        }
        if not client_id:
            params["agent_name_hint"] = AGENT_NAME
        elif account:
            if isinstance(account.get("idToken"), str):
                params["id_token_hint"] = account["idToken"]
            if isinstance(account.get("email"), str):
                params["login_hint"] = account["email"]
        return {
            "authUrl": f"{AUTHORIZE_URL}?{urlencode(params)}",
            "verifier": verifier,
            "state": state,
            "nonce": nonce,
            "clientId": client_id,
        }

    async def complete_login(self, session: dict[str, Any], pasted: str) -> dict[str, Any]:
        params = parse_callback(pasted)
        if params["state"] != session.get("state"):
            raise ChatGptPlanError("This address belongs to a different sign-in attempt. Start again.")

        expected_client = session.get("clientId")
        returned_client = params.get("client_id")
        if expected_client:
            if returned_client and returned_client != expected_client:
                raise ChatGptPlanError("ChatGPT returned a different app registration. Start again.")
            client_id = expected_client
        elif returned_client:
            client_id = returned_client
        else:
            raise ChatGptPlanError(
                "The address is missing the client_id ChatGPT sends on first sign-in. "
                "Copy the whole address from the address bar."
            )

        async with self._client() as http:
            res = await http.post(
                TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "client_id": client_id,
                    "code": params["code"],
                    "code_verifier": session["verifier"],
                    "redirect_uri": REDIRECT_URI,
                    "resource": RESOURCE,
                },
            )
        tokens = self._token_payload(res, "sign in")
        id_token = tokens.get("id_token")
        if not isinstance(id_token, str):
            raise ChatGptPlanError("ChatGPT did not return an ID token.")
        claims = validate_id_token(id_token, client_id=client_id, nonce=session.get("nonce"))

        async with self._lock:
            data = self._load()
            self._host_id(data)
            data["clientId"] = client_id
            data["account"] = {
                "sub": claims["sub"],
                "email": claims.get("email") if isinstance(claims.get("email"), str) else None,
                "issuer": claims["iss"],
                "idToken": id_token,
                **self._token_fields(tokens),
            }
            self._save(data)
            self.models_cache = None
        return self.status()

    # -- tokens -------------------------------------------------------------

    def _token_payload(self, res: httpx.Response, action: str) -> dict[str, Any]:
        try:
            payload = res.json()
        except Exception:
            payload = {}
        if res.status_code != 200 or not isinstance(payload, dict) or "access_token" not in payload:
            err = payload.get("error") if isinstance(payload, dict) else None
            desc = payload.get("error_description") if isinstance(payload, dict) else None
            raise ChatGptPlanError(
                f"Could not {action} with ChatGPT: {desc or err or f'HTTP {res.status_code}'}",
                code=err if isinstance(err, str) else None,
                status=res.status_code,
            )
        return payload

    @staticmethod
    def _token_fields(tokens: dict[str, Any], previous: dict[str, Any] | None = None) -> dict[str, Any]:
        prev = previous or {}
        scope = tokens.get("scope")
        scopes = scope.split() if isinstance(scope, str) else prev.get("scopes") or []
        try:
            expires_in_s = int(tokens.get("expires_in") or 3600)
        except (TypeError, ValueError):
            expires_in_s = 3600
        return {
            "accessToken": tokens["access_token"],
            "refreshToken": tokens.get("refresh_token") or prev.get("refreshToken"),
            "tokenType": tokens.get("token_type") or "Bearer",
            "expiresAt": _now_ms() + expires_in_s * 1000,
            "scopes": scopes,
            "savedAt": _now_ms(),
        }

    async def get_access_token(self) -> str:
        """A usable access token, refreshed first when it is about to expire."""
        async with self._lock:
            data = self._load()
            account = data.get("account")
            if not isinstance(account, dict) or not account.get("accessToken"):
                raise ChatGptPlanError(
                    "ChatGPT is not connected. Connect it in Settings → AI models.", reauth_required=True
                )
            if PLAN_SCOPE not in (account.get("scopes") or []):
                raise ChatGptPlanError(
                    "ChatGPT plan usage is not enabled for Olive. Reconnect ChatGPT and allow plan usage, "
                    "or pick another AI provider.",
                    reauth_required=True,
                )
            if int(account.get("expiresAt") or 0) - _now_ms() > REFRESH_MARGIN_MS:
                return str(account["accessToken"])
            return await self._refresh(data, account)

    async def _refresh(self, data: dict[str, Any], account: dict[str, Any]) -> str:
        refresh_token = account.get("refreshToken")
        client_id = data.get("clientId")
        if not refresh_token or not client_id:
            raise ChatGptPlanError(
                "ChatGPT sign-in expired. Reconnect ChatGPT in Settings → AI models.", reauth_required=True
            )
        async with self._client() as http:
            res = await http.post(
                TOKEN_URL,
                data={
                    "grant_type": "refresh_token",
                    "client_id": client_id,
                    "refresh_token": refresh_token,
                    "resource": RESOURCE,
                },
            )
        try:
            tokens = self._token_payload(res, "refresh the sign-in")
        except ChatGptPlanError as exc:
            if exc.code in TERMINAL_REFRESH_ERRORS:
                # Keep clientId and the identity so reconnecting reuses the registration.
                for key in ("accessToken", "refreshToken", "expiresAt"):
                    account.pop(key, None)
                self._save(data)
                raise ChatGptPlanError(
                    "ChatGPT sign-in expired. Reconnect ChatGPT in Settings → AI models.",
                    code=exc.code,
                    status=exc.status,
                    reauth_required=True,
                ) from exc
            raise
        account.update(self._token_fields(tokens, account))
        if isinstance(tokens.get("id_token"), str):
            account["idToken"] = tokens["id_token"]
        data["account"] = account
        self._save(data)
        return str(account["accessToken"])

    # -- status / sign-out --------------------------------------------------

    def status(self) -> dict[str, Any]:
        account = self._load().get("account")
        if not isinstance(account, dict) or not (account.get("refreshToken") or account.get("accessToken")):
            return {"connected": False, "email": None, "planEnabled": False, "expiresAt": None}
        return {
            "connected": True,
            "email": account.get("email"),
            "planEnabled": PLAN_SCOPE in (account.get("scopes") or []),
            "expiresAt": account.get("expiresAt"),
        }

    def is_usable(self) -> bool:
        st = self.status()
        return bool(st["connected"] and st["planEnabled"])

    async def logout(self) -> dict[str, Any]:
        """Revoke the refresh token (best effort) and forget the tokens."""
        async with self._lock:
            data = self._load()
            account = data.get("account") if isinstance(data.get("account"), dict) else None
            revoked = False
            if account and account.get("refreshToken") and data.get("clientId"):
                try:
                    async with self._client() as http:
                        cfg = (await http.get(OPENID_CONFIGURATION_URL)).json()
                        endpoint = cfg.get("revocation_endpoint") if isinstance(cfg, dict) else None
                        if isinstance(endpoint, str):
                            res = await http.post(
                                endpoint,
                                data={
                                    "token": account["refreshToken"],
                                    "token_type_hint": "refresh_token",
                                    "client_id": data["clientId"],
                                },
                            )
                            revoked = res.status_code == 200
                except Exception:
                    revoked = False
            data.pop("account", None)
            self._save(data)
            self.models_cache = None
        return {"revoked": revoked}


_registry: dict[str, ChatGptPlanAuth] = {}


def get_chatgpt_plan_auth(config_dir: str) -> ChatGptPlanAuth:
    """One instance per credential file, so concurrent refreshes share a lock."""
    path = str(Path(config_dir) / TOKENS_FILENAME)
    auth = _registry.get(path)
    if auth is None:
        auth = _registry[path] = ChatGptPlanAuth(path)
    return auth
