"""Sign in with ChatGPT through the Codex CLI OAuth client.

The same login opencode and pi use: PKCE against ``auth.openai.com`` with the
public Codex client id, then requests to the Codex backend on
``chatgpt.com``. It works where "Sign in with ChatGPT for open-source apps"
is blocked (for example Enterprise workspaces that allow Codex). The
loopback callback never reaches a remote Olive, so the user pastes the
``localhost`` address back, as with the other sign-ins.
"""

from __future__ import annotations

import hashlib
import secrets
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from ..chatgpt_plan.auth import (
    ISSUER,
    TERMINAL_REFRESH_ERRORS,
    ChatGptPlanAuth,
    _b64url,
    _decode_jwt_claims,
    _now_ms,
    parse_callback,
    validate_id_token,
)
from ..chatgpt_plan.errors import ChatGptPlanError

CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
AUTHORIZE_URL = f"{ISSUER}/oauth/authorize"
TOKEN_URL = f"{ISSUER}/oauth/token"
REDIRECT_URI = "http://localhost:1455/auth/callback"
SCOPES = "openid profile email offline_access"
ORIGINATOR = "olive"
TOKENS_FILENAME = "chatgpt-codex-tokens.json"
# Namespaced claim carrying the ChatGPT account (workspace) and plan.
AUTH_CLAIM = "https://api.openai.com/auth"

REFRESH_MARGIN_MS = 5 * 60 * 1000


def _safe_claims(token: Any) -> dict[str, Any]:
    if not isinstance(token, str):
        return {}
    try:
        return _decode_jwt_claims(token)
    except ChatGptPlanError:
        return {}


def account_from_tokens(tokens: dict[str, Any]) -> tuple[str | None, str | None]:
    """The ChatGPT account id and plan type, from the ID token or else the access token."""
    for key in ("id_token", "access_token"):
        claims = _safe_claims(tokens.get(key))
        raw_auth = claims.get(AUTH_CLAIM)
        auth: dict[str, Any] = raw_auth if isinstance(raw_auth, dict) else {}
        orgs = claims.get("organizations")
        account_id = (
            claims.get("chatgpt_account_id")
            or auth.get("chatgpt_account_id")
            or (orgs[0].get("id") if isinstance(orgs, list) and orgs and isinstance(orgs[0], dict) else None)
        )
        if isinstance(account_id, str) and account_id:
            plan = auth.get("chatgpt_plan_type")
            return account_id, plan if isinstance(plan, str) else None
    return None, None


class ChatGptCodexAuth(ChatGptPlanAuth):
    """Owns the Codex-client credential file; storage and token helpers come from the plan auth."""

    # -- sign-in --------------------------------------------------------------

    def start_login(self) -> dict[str, Any]:
        verifier = _b64url(secrets.token_bytes(48))
        state = _b64url(secrets.token_bytes(24))
        params = {
            "response_type": "code",
            "client_id": CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "code_challenge": _b64url(hashlib.sha256(verifier.encode("ascii")).digest()),
            "code_challenge_method": "S256",
            "id_token_add_organizations": "true",
            "codex_cli_simplified_flow": "true",
            "state": state,
            "originator": ORIGINATOR,
        }
        return {"authUrl": f"{AUTHORIZE_URL}?{urlencode(params)}", "verifier": verifier, "state": state}

    async def complete_login(self, session: dict[str, Any], pasted: str) -> dict[str, Any]:
        params = parse_callback(pasted, redirect_uri=REDIRECT_URI)
        if params["state"] != session.get("state"):
            raise ChatGptPlanError("This address belongs to a different sign-in attempt. Start again.")

        async with self._client() as http:
            res = await http.post(
                TOKEN_URL,
                data={
                    "grant_type": "authorization_code",
                    "client_id": CLIENT_ID,
                    "code": params["code"],
                    "code_verifier": session["verifier"],
                    "redirect_uri": REDIRECT_URI,
                },
            )
        tokens = self._token_payload(res, "sign in")
        id_token = tokens.get("id_token")
        if not isinstance(id_token, str):
            raise ChatGptPlanError("ChatGPT did not return an ID token.")
        claims = validate_id_token(id_token, client_id=CLIENT_ID, nonce=None)
        account_id, plan_type = account_from_tokens(tokens)
        if not account_id:
            raise ChatGptPlanError("ChatGPT did not say which account to use. Sign in again.")

        async with self._lock:
            self._save(
                {
                    "account": {
                        "sub": claims["sub"],
                        "email": claims.get("email") if isinstance(claims.get("email"), str) else None,
                        "accountId": account_id,
                        "planType": plan_type,
                        "idToken": id_token,
                        **self._token_fields(tokens),
                    }
                }
            )
            self.models_cache = None
        return self.status()

    # -- tokens -------------------------------------------------------------

    async def get_access_token(self) -> str:
        return (await self.get_credentials())[0]

    async def get_credentials(self) -> tuple[str, str]:
        """A usable access token (refreshed first when about to expire) and the ChatGPT account id."""
        async with self._lock:
            data = self._load()
            account = data.get("account")
            if not isinstance(account, dict) or not account.get("accessToken") or not account.get("accountId"):
                raise ChatGptPlanError(
                    "ChatGPT (Codex) is not connected. Connect it in Settings → AI models.", reauth_required=True
                )
            if int(account.get("expiresAt") or 0) - _now_ms() > REFRESH_MARGIN_MS:
                return str(account["accessToken"]), str(account["accountId"])
            return await self._refresh(data, account), str(account["accountId"])

    async def _refresh(self, data: dict[str, Any], account: dict[str, Any]) -> str:
        refresh_token = account.get("refreshToken")
        if not refresh_token:
            raise ChatGptPlanError(
                "ChatGPT sign-in expired. Reconnect ChatGPT (Codex) in Settings → AI models.", reauth_required=True
            )
        async with self._client() as http:
            res = await http.post(
                TOKEN_URL,
                data={"grant_type": "refresh_token", "client_id": CLIENT_ID, "refresh_token": refresh_token},
            )
        try:
            tokens = self._token_payload(res, "refresh the sign-in")
        except ChatGptPlanError as exc:
            if exc.code in TERMINAL_REFRESH_ERRORS:
                for key in ("accessToken", "refreshToken", "expiresAt"):
                    account.pop(key, None)
                self._save(data)
                raise ChatGptPlanError(
                    "ChatGPT sign-in expired. Reconnect ChatGPT (Codex) in Settings → AI models.",
                    code=exc.code,
                    status=exc.status,
                    reauth_required=True,
                ) from exc
            raise
        account.update(self._token_fields(tokens, account))
        if isinstance(tokens.get("id_token"), str):
            account["idToken"] = tokens["id_token"]
        account_id, plan_type = account_from_tokens(tokens)
        if account_id:
            account["accountId"] = account_id
            account["planType"] = plan_type or account.get("planType")
        data["account"] = account
        self._save(data)
        return str(account["accessToken"])

    # -- status / sign-out --------------------------------------------------

    def status(self) -> dict[str, Any]:
        account = self._load().get("account")
        if not isinstance(account, dict) or not (account.get("refreshToken") or account.get("accessToken")):
            return {"connected": False, "email": None, "planType": None, "expiresAt": None}
        return {
            "connected": True,
            "email": account.get("email"),
            "planType": account.get("planType"),
            "expiresAt": account.get("expiresAt"),
        }

    def is_usable(self) -> bool:
        account = self._load().get("account")
        return bool(
            isinstance(account, dict)
            and account.get("accountId")
            and (account.get("refreshToken") or account.get("accessToken"))
        )

    async def logout(self) -> dict[str, Any]:
        """Forget the tokens; the Codex client has no revocation endpoint Olive can call."""
        async with self._lock:
            self._save({})
            self.models_cache = None
        return {"revoked": False}


_registry: dict[str, ChatGptCodexAuth] = {}


def get_chatgpt_codex_auth(config_dir: str) -> ChatGptCodexAuth:
    """One instance per credential file, so concurrent refreshes share a lock."""
    path = str(Path(config_dir) / TOKENS_FILENAME)
    auth = _registry.get(path)
    if auth is None:
        auth = _registry[path] = ChatGptCodexAuth(path)
    return auth
