"""Plaud client factory and token path resolver (port of packages/server/src/plaud/client.ts)."""

from __future__ import annotations

import os
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..settings import OlivePaths, resolve_paths
from .sdk import FileTokenStore, PlaudClient


def _expand_home_path(path: str) -> str:
    if path == "~":
        return str(Path.home())
    if path.startswith("~/") or path.startswith("~\\"):
        return str(Path.home() / path[2:])
    return path


def resolve_plaud_token_path(
    paths: OlivePaths | dict[str, Any] | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    effective_env = env if env is not None else os.environ
    resolved = paths or resolve_paths(effective_env)
    plaud_tokens_path = (
        resolved["plaudTokensPath"]
        if isinstance(resolved, dict)
        else resolved.plaud_tokens_path
    )
    configured = (effective_env.get("PLAUD_TOKEN_PATH") or "").strip()
    token_path = _expand_home_path(configured) if configured else str(plaud_tokens_path)

    p = Path(token_path)
    p.parent.mkdir(parents=True, exist_ok=True)

    if not p.exists():
        legacy = Path.home() / ".plaud" / "tokens.json"
        if legacy.exists():
            try:
                shutil.copy2(legacy, p)
            except Exception:
                pass

    return str(p)


resolvePlaudTokenPath = resolve_plaud_token_path


def create_plaud_client(
    paths: OlivePaths | dict[str, Any] | None = None,
    env: Mapping[str, str] | None = None,
) -> PlaudClient:
    token_path = resolve_plaud_token_path(paths, env)
    token_store = FileTokenStore(token_path)
    return PlaudClient({"tokenStore": token_store})


createPlaudClient = create_plaud_client
