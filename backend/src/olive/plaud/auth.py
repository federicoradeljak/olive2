"""Plaud OAuth PKCE in-memory session store (port of packages/server/src/plaud/auth.ts)."""

from __future__ import annotations

import time
import uuid
from typing import Any

AUTH_SESSION_TTL_MS = 5 * 60 * 1000


class PlaudAuthSessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, dict[str, Any]] = {}

    def create(self, session: dict[str, str], now: int | None = None) -> str:
        t = now if now is not None else int(time.time() * 1000)
        self._remove_expired(t)
        session_id = str(uuid.uuid4())
        self._sessions[session_id] = {
            "verifier": session["verifier"],
            "state": session["state"],
            "expiresAt": t + AUTH_SESSION_TTL_MS,
        }
        return session_id

    def get(self, session_id: str, now: int | None = None) -> dict[str, Any] | None:
        t = now if now is not None else int(time.time() * 1000)
        self._remove_expired(t)
        return self._sessions.get(session_id)

    def consume(self, session_id: str, now: int | None = None) -> dict[str, Any] | None:
        t = now if now is not None else int(time.time() * 1000)
        self._remove_expired(t)
        return self._sessions.pop(session_id, None)

    def delete(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def _remove_expired(self, now: int) -> None:
        expired = [sid for sid, s in self._sessions.items() if int(s["expiresAt"]) <= now]
        for sid in expired:
            self._sessions.pop(sid, None)
