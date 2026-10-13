"""Vendored Python port of @mcowger/plaud-client (OAuth 2.0 PKCE, FileTokenStore, PlaudClient, formatters)."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import sys
import time
import urllib.parse
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx

DEFAULT_CLIENT_ID = "client_f9e0b214-c11f-434b-8b95-c4497d1feb81"
DEFAULT_REDIRECT_URI = "http://localhost:8199/auth/callback"
DEFAULT_CALLBACK_PORT = 8199
DEFAULT_AUTH_URL = "https://web.plaud.ai/platform/oauth"
DEFAULT_TOKEN_URL = "https://platform.plaud.ai/developer/api/oauth/third-party/access-token"
DEFAULT_REFRESH_URL = "https://platform.plaud.ai/developer/api/oauth/third-party/access-token/refresh"
DEFAULT_API_BASE = "https://platform.plaud.ai/developer/api"


class PlaudError(Exception):
    pass


class AuthError(PlaudError):
    pass


class NotFoundError(PlaudError):
    pass


class RateLimitError(PlaudError):
    def __init__(self, message: str = "Rate limit exceeded.", retry_after_ms: int | None = None) -> None:
        super().__init__(message)
        self.retryAfterMs = retry_after_ms
        self.retry_after_ms = retry_after_ms
        self.status = 429


class NetworkError(PlaudError):
    def __init__(self, message: str, cause: Exception | None = None) -> None:
        super().__init__(message)
        self.__cause__ = cause


class TimeoutError(PlaudError):  # noqa: A001
    pass


class ApiError(PlaudError):
    def __init__(self, status: int, message: str, body: str = "") -> None:
        super().__init__(f"API Error ({status}): {message}")
        self.status = status
        self.body = body


def base64_url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


base64UrlEncode = base64_url_encode


def generate_random_string(bytes_length: int = 32) -> str:
    return base64_url_encode(secrets.token_bytes(bytes_length))


generateRandomString = generate_random_string


async def generate_code_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64_url_encode(digest)


generateCodeChallenge = generate_code_challenge


class FileTokenStore:
    def __init__(self, file_path: str | Path | None = None) -> None:
        if file_path:
            self.filePath = str(file_path)
        else:
            home = os.environ.get("HOME") or os.environ.get("USERPROFILE") or str(Path.home())
            self.filePath = str(Path(home) / ".plaud" / "tokens.json")
        self.file_path = self.filePath

    async def load(self) -> dict[str, Any] | None:
        try:
            content = Path(self.filePath).read_text(encoding="utf-8")
            parsed = json.loads(content)
            if isinstance(parsed, dict) and isinstance(parsed.get("access_token"), str):
                return {
                    "access_token": parsed["access_token"],
                    "refresh_token": parsed.get("refresh_token"),
                    "token_type": parsed.get("token_type") or "Bearer",
                    "expires_at": parsed.get("expires_at"),
                }
        except Exception:
            pass
        return None

    async def save(self, tokens: dict[str, Any]) -> None:
        p = Path(self.filePath)
        p.parent.mkdir(parents=True, exist_ok=True)
        if sys.platform != "win32":
            try:
                p.parent.chmod(0o700)
            except Exception:
                pass
        p.write_text(json.dumps(tokens, indent=2), encoding="utf-8")
        if sys.platform != "win32":
            try:
                p.chmod(0o600)
            except Exception:
                pass

    async def clear(self) -> None:
        try:
            Path(self.filePath).unlink(missing_ok=True)
        except Exception:
            pass


class MemoryTokenStore:
    def __init__(self, initial_tokens: dict[str, Any] | None = None) -> None:
        self.tokens = dict(initial_tokens) if initial_tokens else None

    async def load(self) -> dict[str, Any] | None:
        return dict(self.tokens) if self.tokens else None

    async def save(self, tokens: dict[str, Any]) -> None:
        self.tokens = dict(tokens)

    async def clear(self) -> None:
        self.tokens = None


class OAuthManager:
    def __init__(self, config: dict[str, Any] | None = None, **kwargs: Any) -> None:
        cfg = {**(config or {}), **kwargs}
        self.clientId = str(cfg.get("clientId") or DEFAULT_CLIENT_ID)
        self.redirectUri = str(cfg.get("redirectUri") or DEFAULT_REDIRECT_URI)
        self.callbackPort = int(cfg.get("callbackPort") or DEFAULT_CALLBACK_PORT)
        self.authUrl = str(cfg.get("authUrl") or DEFAULT_AUTH_URL)
        self.tokenUrl = str(cfg.get("tokenUrl") or DEFAULT_TOKEN_URL)
        self.refreshUrl = str(cfg.get("refreshUrl") or DEFAULT_REFRESH_URL)
        self.refreshWindowMs = int(cfg.get("refreshWindowMs") or 48 * 60 * 60 * 1000)
        self.tokenStore = cfg.get("tokenStore") or cfg.get("token_store") or FileTokenStore()
        self.token_store = self.tokenStore

    async def get_access_token(self) -> str | None:
        tokens = await self.tokenStore.load()
        if not tokens:
            return None
        now = int(time.time() * 1000)
        expires_at = int(tokens.get("expires_at") or 0)
        if expires_at and (expires_at - now) <= self.refreshWindowMs:
            refresh_tok = tokens.get("refresh_token")
            if refresh_tok:
                try:
                    refreshed = await self.refresh(refresh_tok)
                    return refreshed["access_token"]
                except Exception:
                    if now < expires_at:
                        return tokens["access_token"]
                    return None
            if now >= expires_at:
                return None
        return tokens["access_token"]

    getAccessToken = get_access_token

    async def exchange(self, code: str, verifier: str, state: str = "") -> dict[str, Any]:
        basic_auth = base64.b64encode(f"{self.clientId}:".encode()).decode("ascii")
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                res = await client.post(
                    self.tokenUrl,
                    headers={
                        "Authorization": f"Basic {basic_auth}",
                        "Accept": "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    data={
                        "code": code,
                        "redirect_uri": self.redirectUri,
                        "code_verifier": verifier,
                        "state": state,
                    },
                )
        except Exception as exc:
            raise NetworkError("Failed to connect to OAuth token endpoint.", exc) from exc

        if res.status_code >= 400:
            raise AuthError(f"OAuth code exchange failed ({res.status_code}): {res.text}")

        data = res.json()
        now_ms = int(time.time() * 1000)
        token_set: dict[str, Any] = {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token"),
            "token_type": data.get("token_type") or "Bearer",
        }
        if data.get("expires_in"):
            token_set["expires_at"] = now_ms + int(data["expires_in"]) * 1000
        await self.tokenStore.save(token_set)
        return token_set

    async def refresh(self, refresh_token: str) -> dict[str, Any]:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                res = await client.post(
                    self.refreshUrl,
                    headers={
                        "Accept": "application/json",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    data={"refresh_token": refresh_token},
                )
        except Exception as exc:
            raise NetworkError("Failed to connect to OAuth refresh endpoint.", exc) from exc

        if res.status_code >= 400:
            raise AuthError(f"OAuth token refresh failed ({res.status_code}): {res.text}")

        data = res.json()
        now_ms = int(time.time() * 1000)
        token_set: dict[str, Any] = {
            "access_token": data["access_token"],
            "refresh_token": data.get("refresh_token") or refresh_token,
            "token_type": data.get("token_type") or "Bearer",
        }
        if data.get("expires_in"):
            token_set["expires_at"] = now_ms + int(data["expires_in"]) * 1000
        await self.tokenStore.save(token_set)
        return token_set

    async def logout(self) -> None:
        await self.tokenStore.clear()

    async def start_manual_login(self) -> dict[str, str]:
        verifier = generate_random_string(32)
        challenge = await generate_code_challenge(verifier)
        state = generate_random_string(16)
        params = urllib.parse.urlencode(
            {
                "client_id": self.clientId,
                "redirect_uri": self.redirectUri,
                "response_type": "code",
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "state": state,
            }
        )
        return {
            "authUrl": f"{self.authUrl}?{params}",
            "verifier": verifier,
            "state": state,
        }

    startManualLogin = start_manual_login

    async def complete_manual_login(
        self,
        input_url_or_code: str,
        verifier: str,
        expected_state: str | None = None,
    ) -> dict[str, Any]:
        code = input_url_or_code.strip()
        state_param: str | None = None
        if "?" in code or "&" in code or code.startswith("http"):
            url_str = (
                code
                if code.startswith("http")
                else f"http://localhost:{self.callbackPort}{'' if code.startswith('/') else '/'}{code}"
            )
            parsed = urllib.parse.urlparse(url_str)
            qs = urllib.parse.parse_qs(parsed.query)
            if "error" in qs and qs["error"]:
                raise AuthError(f"Authorization denied: {qs['error'][0]}")
            if "code" not in qs or not qs["code"]:
                raise AuthError("No authorization code found in pasted URL.")
            code = qs["code"][0]
            state_param = qs.get("state", [None])[0]

        if expected_state and state_param and state_param != expected_state:
            raise AuthError("OAuth state mismatch. The callback state does not match login state.")

        return await self.exchange(code, verifier, expected_state or state_param or "")

    completeManualLogin = complete_manual_login


class PlaudClient:
    def __init__(self, config: dict[str, Any] | None = None, **kwargs: Any) -> None:
        cfg = {**(config or {}), **kwargs}
        self.apiBase = str(cfg.get("apiBase") or DEFAULT_API_BASE).rstrip("/")
        self.timeoutMs = int(cfg.get("timeoutMs") or 30_000)
        self.maxRetries = int(cfg.get("maxRetries") or 3)
        self.oauth = OAuthManager(cfg)
        self.tokenStore = self.oauth.tokenStore

    async def request(
        self,
        method: str,
        path: str,
        options: dict[str, Any] | None = None,
    ) -> Any:
        opts = options or {}
        token = await self.oauth.get_access_token()
        if not token:
            raise AuthError("Not authenticated. Please run login first.")

        url = f"{self.apiBase}{path}"
        params = {k: str(v) for k, v in (opts.get("query") or {}).items() if v is not None}
        attempt = 0

        while True:
            attempt += 1
            try:
                headers = {
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                }
                async with httpx.AsyncClient(timeout=self.timeoutMs / 1000.0) as client:
                    res = await client.request(
                        method,
                        url,
                        params=params if params else None,
                        headers=headers,
                        json=opts.get("body") if "body" in opts else None,
                    )

                if res.status_code >= 400:
                    status = res.status_code
                    body_text = res.text
                    if status in (401, 403):
                        raise AuthError(f"Authentication failed ({status}): {body_text}")
                    if status == 404:
                        raise NotFoundError(f"Resource not found ({path}): {body_text}")
                    if status == 429:
                        retry_hdr = res.headers.get("retry-after")
                        retry_ms = int(retry_hdr) * 1000 if (retry_hdr and retry_hdr.isdigit()) else None
                        raise RateLimitError("Rate limit exceeded.", retry_ms)
                    if status >= 500 and attempt <= self.maxRetries:
                        await asyncio.sleep((2**attempt) * 0.2)
                        continue
                    raise ApiError(status, res.reason_phrase or "Error", body_text)

                return res.json()
            except (AuthError, NotFoundError, RateLimitError, ApiError):
                raise
            except httpx.TimeoutException as exc:
                raise TimeoutError(f"Request timed out after {self.timeoutMs}ms.") from exc
            except Exception as exc:
                if attempt <= self.maxRetries:
                    await asyncio.sleep((2**attempt) * 0.2)
                    continue
                raise NetworkError(f"Request failed: {exc}", exc) from exc

    async def get_current_user(self) -> dict[str, Any]:
        return await self.request("GET", "/open/third-party/users/current")

    getCurrentUser = get_current_user

    async def revoke_current_user(self) -> None:
        try:
            await self.request("POST", "/open/third-party/users/current/revoke")
        except Exception:
            pass

    revokeCurrentUser = revoke_current_user

    async def list_files(self, options: dict[str, Any] | None = None) -> dict[str, Any]:
        opts = options or {}
        page = int(opts.get("page") or 1)
        page_size = int(opts.get("pageSize") or opts.get("page_size") or 20)
        query: dict[str, Any] = {"page": page, "page_size": page_size}
        if opts.get("dateFrom"):
            df = opts["dateFrom"]
            query["date_from"] = df.isoformat() if hasattr(df, "isoformat") else str(df)
        if opts.get("dateTo"):
            dt = opts["dateTo"]
            query["date_to"] = dt.isoformat() if hasattr(dt, "isoformat") else str(dt)
        return await self.request("GET", "/open/third-party/files/", {"query": query})

    listFiles = list_files

    async def get_file(self, file_id: str) -> dict[str, Any]:
        if not file_id:
            raise ValueError("File ID is required.")
        return await self.request("GET", f"/open/third-party/files/{urllib.parse.quote(file_id)}")

    getFile = get_file

    async def get_audio_url(self, file_id: str) -> str | None:
        file_obj = await self.get_file(file_id)
        return file_obj.get("presigned_url")

    getAudioUrl = get_audio_url

    async def list_files_iterator(
        self, options: dict[str, Any] | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        opts = options or {}
        page_size = int(opts.get("pageSize") or opts.get("page_size") or 20)
        current_page = 1
        while True:
            page_data = await self.list_files({**opts, "page": current_page, "pageSize": page_size})
            items = page_data.get("data") or []
            if not items:
                break
            for item in items:
                yield item
            if len(items) < page_size:
                break
            current_page += 1

    listFilesIterator = list_files_iterator


def format_srt_timestamp(ms: float) -> str:
    total_ms = max(0, int(ms))
    hours = total_ms // 3_600_000
    minutes = (total_ms % 3_600_000) // 60_000
    seconds = (total_ms % 60_000) // 1_000
    millis = total_ms % 1_000
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


formatSrtTimestamp = format_srt_timestamp


def format_display_timestamp(ms: float) -> str:
    total_sec = max(0, int(ms // 1000))
    hours = total_sec // 3600
    minutes = (total_sec % 3600) // 60
    seconds = total_sec % 60
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    return f"{minutes:02d}:{seconds:02d}"


formatDisplayTimestamp = format_display_timestamp


PLAUD_FILE_ID_PREFIX = "of_"


def canonical_plaud_file_id(file_id: str) -> str:
    """Return the stable recording identity for a Plaud file ID.

    Plaud migrated recording IDs from bare hex (``69bf84fe...``) to an ``of_``
    prefixed form (``of_69bf84fe...``) while keeping the same underlying
    recording. The suffix is the stable identity, so strip the prefix before
    comparing IDs so the same recording is not ingested twice.
    """
    if file_id.startswith(PLAUD_FILE_ID_PREFIX):
        return file_id[len(PLAUD_FILE_ID_PREFIX) :]
    return file_id


canonicalPlaudFileId = canonical_plaud_file_id


def alternate_plaud_file_id(file_id: str) -> str | None:
    """Return the other known form of a Plaud file ID, or ``None`` if equal."""
    canonical = canonical_plaud_file_id(file_id)
    alternate = (
        canonical if file_id.startswith(PLAUD_FILE_ID_PREFIX) else f"{PLAUD_FILE_ID_PREFIX}{canonical}"
    )
    return alternate if alternate != file_id else None


alternatePlaudFileId = alternate_plaud_file_id


def parse_transcript_segments(source_list: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    for item in source_list or []:
        if not isinstance(item, dict):
            continue
        dc = item.get("data_content")
        if not dc:
            continue
        try:
            parsed = json.loads(dc) if isinstance(dc, str) else dc
            if isinstance(parsed, list):
                for elem in parsed:
                    if isinstance(elem, dict):
                        segments.append(
                            {
                                "start_time": float(elem.get("start_time") or 0),
                                "end_time": float(elem.get("end_time") or 0),
                                "speaker": elem.get("speaker"),
                                "content": str(elem.get("content") or ""),
                            }
                        )
            elif isinstance(parsed, dict):
                segments.append(
                    {
                        "start_time": float(parsed.get("start_time") or 0),
                        "end_time": float(parsed.get("end_time") or 0),
                        "speaker": parsed.get("speaker"),
                        "content": str(parsed.get("content") or ""),
                    }
                )
        except Exception:
            segments.append(
                {
                    "start_time": 0,
                    "end_time": 0,
                    "speaker": None,
                    "content": str(dc).strip(),
                }
            )
    segments.sort(key=lambda s: s["start_time"])
    return segments


parseTranscriptSegments = parse_transcript_segments


def extract_summary_notes(note_list: list[dict[str, Any]] | None = None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in note_list or []:
        if not isinstance(item, dict) or not item.get("data_content"):
            continue
        raw = str(item["data_content"])
        content = raw
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, str):
                content = parsed
            elif isinstance(parsed, dict):
                content = str(
                    parsed.get("content")
                    or parsed.get("summary")
                    or parsed.get("markdown")
                    or json.dumps(parsed, indent=2)
                )
        except Exception:
            pass
        out.append(
            {
                "type": str(item.get("data_type") or "summary"),
                "content": content.strip(),
            }
        )
    return out


extractSummaryNotes = extract_summary_notes


def segments_to_text(
    segments: list[dict[str, Any]],
    speaker_map: dict[str, str] | None = None,
) -> str:
    lines: list[str] = []
    for seg in segments:
        raw_spk = str(seg.get("speaker") or "Speaker")
        spk = (speaker_map or {}).get(raw_spk, raw_spk)
        lines.append(f"{spk}: {seg.get('content', '')}")
    return "\n\n".join(lines)


segmentsToText = segments_to_text
