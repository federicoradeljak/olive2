#!/usr/bin/env python3
"""Lightweight utility to output Olive dev server config values (port, FRP URL).

Usage:
  python3 scripts/dev_config.py port
  python3 scripts/dev_config.py frp_url [--hostname|--subdomain|--json|--file]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from frpc import (  # noqa: E402
    FrpcEndpoint,
    build_frpc_endpoint,
    get_frpc_url_file_path,
    get_repository_name,
    hydrate_mise_env,
    is_frpc_available,
)
from paseo_port import allocate_port, current_git_branch  # noqa: E402


def get_port() -> str:
    for key in ("PORT", "PASEO_PORT", "OLIVE_WEB_PORT"):
        val = (os.environ.get(key) or "").strip()
        if val:
            return val
    return str(allocate_port(branch=current_git_branch()))


def get_frp_endpoint() -> FrpcEndpoint:
    hydrate_mise_env(ROOT_DIR)
    server_addr = (os.environ.get("FRPC_SERVER_ADDR") or "").strip()
    token = (os.environ.get("FRPC_AUTH_TOKEN") or "").strip()
    if not server_addr or not token:
        raise RuntimeError("FRP is not configured: set FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN.")
    if not is_frpc_available():
        raise RuntimeError("FRP is not available: install frpc or add it to PATH.")

    worktree_name = ROOT_DIR.name
    return build_frpc_endpoint(
        get_repository_name(ROOT_DIR),
        worktree_name,
        os.environ.get("FRPC_SUBDOMAIN_HOST"),
    )


def print_frp_endpoint(args: list[str]) -> None:
    worktree_name = ROOT_DIR.name
    url_file = get_frpc_url_file_path(worktree_name)
    if "--file" in args:
        print(url_file)
        return

    endpoint = get_frp_endpoint()
    hostname = urlparse(endpoint.url).hostname if endpoint.url else None

    if "--json" in args:
        print(
            json.dumps(
                {
                    "subdomain": endpoint.subdomain,
                    "url": endpoint.url,
                    "hostname": hostname,
                    "urlFile": url_file,
                }
            )
        )
        return
    if "--subdomain" in args:
        print(endpoint.subdomain)
        return
    if "--hostname" in args:
        if not hostname:
            raise RuntimeError("FRPC_SUBDOMAIN_HOST is not set; cannot build the hostname.")
        print(hostname)
        return
    if not endpoint.url:
        raise RuntimeError("FRPC_SUBDOMAIN_HOST is not set; use --subdomain or configure the host.")
    print(endpoint.url)


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if cmd == "port":
            print(get_port())
        elif cmd == "frp_url":
            print_frp_endpoint(sys.argv[2:])
        else:
            raise RuntimeError(
                "Usage: python3 scripts/dev_config.py <port|frp_url> "
                "[--hostname|--subdomain|--json|--file]"
            )
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
