#!/usr/bin/env python3
"""FRP client (frpc) helpers for deterministic worktree HTTP tunnels."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_FRPC_SERVER_PORT = 7000
MAX_DNS_LABEL_LENGTH = 63
LONG_LABEL_HASH_LENGTH = 8
FRPC_URL_FILE_SUFFIX = ".frpc-url"


@dataclass(frozen=True)
class FrpcEndpoint:
    subdomain: str
    url: str | None = None


@dataclass(frozen=True)
class FrpcProxyOptions:
    server_addr: str
    server_port: int
    token: str
    proxy_name: str
    local_port: int
    subdomain: str


def sanitize_dns_label(value: str, fallback: str) -> str:
    label = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return label or fallback


def repository_name_from_remote(remote: str) -> str:
    trimmed = re.sub(r"\.git$", "", remote.strip().rstrip("/\\"), flags=re.IGNORECASE)
    parts = [p for p in re.split(r"[/:]", trimmed) if p]
    return parts[-1] if parts else "repo"


def get_repository_name(cwd: str | Path | None = None) -> str:
    work_dir = Path(cwd or Path.cwd()).resolve()
    try:
        out = subprocess.check_output(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=str(work_dir),
            stderr=subprocess.DEVNULL,
            text=True,
        )
        return repository_name_from_remote(out)
    except Exception:
        return work_dir.name


def is_frpc_available() -> bool:
    try:
        subprocess.run(
            ["frpc", "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
        return True
    except Exception:
        return False


def build_frpc_subdomain(repository_name: str, worktree_name: str) -> str:
    base = (
        f"{sanitize_dns_label(repository_name, 'repo')}-"
        f"{sanitize_dns_label(worktree_name, 'worktree')}"
    )
    if len(base) <= MAX_DNS_LABEL_LENGTH:
        return base

    digest = hashlib.sha256(
        f"{repository_name}\0{worktree_name}".encode()
    ).hexdigest()[:LONG_LABEL_HASH_LENGTH]
    prefix = base[: MAX_DNS_LABEL_LENGTH - LONG_LABEL_HASH_LENGTH - 1].rstrip("-")
    return f"{prefix}-{digest}"


def build_frpc_url(subdomain: str, subdomain_host: str | None = None) -> str | None:
    host = (subdomain_host or "").strip().rstrip(".")
    return f"https://{subdomain}.{host}" if host else None


def build_frpc_endpoint(
    repository_name: str,
    worktree_name: str,
    subdomain_host: str | None = None,
) -> FrpcEndpoint:
    subdomain = build_frpc_subdomain(repository_name, worktree_name)
    return FrpcEndpoint(
        subdomain=subdomain,
        url=build_frpc_url(subdomain, subdomain_host),
    )


def get_frpc_url_file_path(worktree_name: str | None = None) -> str:
    wt = worktree_name or Path.cwd().name
    return os.path.join(tempfile.gettempdir(), f"olive-{wt}{FRPC_URL_FILE_SUFFIX}")


def write_frpc_url_file(url: str, worktree_name: str | None = None) -> None:
    file_path = get_frpc_url_file_path(worktree_name)
    tmp_path = f"{file_path}.{os.getpid()}.tmp"
    try:
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"{url}\n")
        os.replace(tmp_path, file_path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def read_frpc_url_file(worktree_name: str | None = None) -> str | None:
    try:
        with open(get_frpc_url_file_path(worktree_name), encoding="utf-8") as f:
            val = f.read().strip()
            return val or None
    except OSError:
        return None


def remove_frpc_url_file(worktree_name: str | None = None) -> None:
    try:
        os.unlink(get_frpc_url_file_path(worktree_name))
    except OSError:
        pass


def build_frpc_args(options: FrpcProxyOptions) -> list[str]:
    return [
        "http",
        "--server-addr",
        options.server_addr,
        "--server-port",
        str(options.server_port),
        "--token",
        options.token,
        "--proxy-name",
        options.proxy_name,
        "--local-ip",
        "127.0.0.1",
        "--local-port",
        str(options.local_port),
        "--sd",
        options.subdomain,
    ]


def hydrate_mise_env(cwd: str | Path | None = None) -> None:
    """Populate FRPC_* / HF_TOKEN from `mise env --json` if running in a non-interactive shell."""
    if os.environ.get("FRPC_SERVER_ADDR") and os.environ.get("FRPC_AUTH_TOKEN"):
        return
    work_dir = Path(cwd or Path.cwd()).resolve()
    try:
        out = subprocess.check_output(
            ["mise", "env", "--json"],
            cwd=str(work_dir),
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5.0,
        )
        data = json.loads(out)
        if isinstance(data, dict):
            for key, value in data.items():
                if (
                    isinstance(key, str)
                    and isinstance(value, str)
                    and (key.startswith("FRPC_") or key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"))
                    and not os.environ.get(key)
                ):
                    os.environ[key] = value
    except Exception:
        pass


def parse_frpc_server_port(env: Mapping[str, str]) -> int | None:
    raw = env.get("FRPC_SERVER_PORT")
    if raw is None or raw == "":
        return DEFAULT_FRPC_SERVER_PORT
    try:
        port = int(raw)
    except ValueError:
        return None
    if port < 1 or port > 65535:
        return None
    return port
