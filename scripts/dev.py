#!/usr/bin/env python3
"""Concurrent development runner for Olive backend (uvicorn --reload), frontend (Vite HMR), and optional frpc tunnel."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parent
BACKEND_DIR = ROOT_DIR / "backend"
FRONTEND_DIR = ROOT_DIR / "frontend"

if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from frpc import (  # noqa: E402
    FrpcProxyOptions,
    build_frpc_args,
    build_frpc_endpoint,
    get_frpc_url_file_path,
    get_repository_name,
    hydrate_mise_env,
    is_frpc_available,
    parse_frpc_server_port,
    remove_frpc_url_file,
    write_frpc_url_file,
)
from paseo_port import allocate_port, current_git_branch  # noqa: E402


def wait_for_local_server(port: int, timeout_sec: float = 30.0) -> None:
    url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.monotonic() + timeout_sec
    consecutive_ok = 0
    required_ok = 3
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2.0) as resp:
                if 200 <= resp.status < 300:
                    consecutive_ok += 1
                    if consecutive_ok >= required_ok:
                        return
                else:
                    consecutive_ok = 0
        except Exception:
            consecutive_ok = 0
        time.sleep(0.5)
    raise RuntimeError(f"Server did not become ready at {url} within {timeout_sec:.0f}s")


def main() -> None:
    hydrate_mise_env(ROOT_DIR)
    worktree_name = ROOT_DIR.name

    raw_public_port = (
        os.environ.get("PORT")
        or os.environ.get("PASEO_PORT")
        or os.environ.get("OLIVE_WEB_PORT")
    )
    public_port = (
        int(raw_public_port)
        if raw_public_port
        else allocate_port(branch=current_git_branch())
    )
    default_backend_port = int(os.environ.get("OLIVE_BIND_PORT") or "4471")
    backend_port = 4472 if public_port == default_backend_port else default_backend_port
    api_target = os.environ.get("OLIVE_API_TARGET") or f"http://127.0.0.1:{backend_port}"

    remove_frpc_url_file(worktree_name)

    backend_env = {
        **os.environ,
        "OLIVE_BIND_PORT": str(backend_port),
        "PORT": str(backend_port),
    }
    frontend_env = {
        **os.environ,
        "OLIVE_API_TARGET": api_target,
    }

    print(f"Starting Olive Dev Stack (worktree={worktree_name})...", flush=True)
    print(f"  Frontend (Vite): http://127.0.0.1:{public_port}", flush=True)
    print(f"  Backend (API):   {api_target}", flush=True)

    server_proc = subprocess.Popen(
        [
            "uv",
            "run",
            "uvicorn",
            "olive.main:app",
            "--reload",
            "--log-config",
            "uvicorn_log_config.json",
            "--host",
            os.environ.get("OLIVE_BIND_HOST") or "127.0.0.1",
            "--port",
            str(backend_port),
        ],
        cwd=str(BACKEND_DIR),
        env=backend_env,
    )

    web_proc = subprocess.Popen(
        [
            "pnpm",
            "exec",
            "vite",
            "--host",
            os.environ.get("OLIVE_BIND_HOST") or "127.0.0.1",
            "--port",
            str(public_port),
            "--strictPort",
        ],
        cwd=str(FRONTEND_DIR),
        env=frontend_env,
    )

    frpc_proc: subprocess.Popen[bytes] | None = None
    shutting_down = False
    lock = threading.Lock()

    def start_frpc() -> None:
        nonlocal frpc_proc
        if not is_frpc_available():
            print("[frpc] Tunnel disabled: frpc is not available on PATH.")
            return

        server_addr = (os.environ.get("FRPC_SERVER_ADDR") or "").strip()
        token = (os.environ.get("FRPC_AUTH_TOKEN") or "").strip()
        if not server_addr and not token:
            print("[frpc] Tunnel disabled: FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN are not set.")
            return
        if not server_addr or not token:
            print(
                "[frpc] Tunnel disabled: set both FRPC_SERVER_ADDR and FRPC_AUTH_TOKEN.",
                file=sys.stderr,
            )
            return

        server_port = parse_frpc_server_port(os.environ)
        if server_port is None:
            print(
                f'[frpc] Tunnel disabled: invalid FRPC_SERVER_PORT "{os.environ.get("FRPC_SERVER_PORT")}".',
                file=sys.stderr,
            )
            return

        endpoint = build_frpc_endpoint(
            get_repository_name(ROOT_DIR),
            worktree_name,
            os.environ.get("FRPC_SUBDOMAIN_HOST"),
        )
        args = build_frpc_args(
            FrpcProxyOptions(
                server_addr=server_addr,
                server_port=server_port,
                token=token,
                proxy_name=endpoint.subdomain,
                local_port=public_port,
                subdomain=endpoint.subdomain,
            )
        )

        with lock:
            if shutting_down:
                return
            if endpoint.url:
                write_frpc_url_file(endpoint.url, worktree_name)
            print(f"[frpc] Starting tunnel for subdomain: {endpoint.subdomain}")
            try:
                frpc_proc = subprocess.Popen(
                    ["frpc", *args],
                    cwd=str(ROOT_DIR),
                    env={**os.environ},
                )
            except Exception as exc:
                remove_frpc_url_file(worktree_name)
                print(f"[frpc] Failed to start tunnel: {exc}", file=sys.stderr)
                return

            if endpoint.url:
                print(f"[frpc] URL={endpoint.url}")
                print(f"[frpc] URL file: {get_frpc_url_file_path(worktree_name)}")
            else:
                print(f"[frpc] Subdomain={endpoint.subdomain}")

    def launch_frpc_when_ready() -> None:
        try:
            wait_for_local_server(backend_port, timeout_sec=30.0)
            wait_for_local_server(public_port, timeout_sec=15.0)
            start_frpc()
        except Exception as exc:
            if not shutting_down:
                print(
                    f"[frpc] Tunnel disabled: server did not become ready ({exc}).",
                    file=sys.stderr,
                    flush=True,
                )

    tunnel_thread = threading.Thread(target=launch_frpc_when_ready, daemon=True)
    tunnel_thread.start()

    def cleanup(_sig: int | None = None, _frame: object = None) -> None:
        nonlocal shutting_down
        with lock:
            if shutting_down:
                return
            shutting_down = True
            procs = [p for p in (frpc_proc, web_proc, server_proc) if p is not None]
        remove_frpc_url_file(worktree_name)
        for p in procs:
            if p.poll() is None:
                try:
                    p.terminate()
                except Exception:
                    pass
        for p in procs:
            try:
                p.wait(timeout=5.0)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass

    signal.signal(signal.SIGINT, lambda s, f: (cleanup(s, f), sys.exit(0)))  # type: ignore[misc]
    signal.signal(signal.SIGTERM, lambda s, f: (cleanup(s, f), sys.exit(0)))  # type: ignore[misc]
    if hasattr(signal, "SIGHUP"):
        signal.signal(signal.SIGHUP, lambda s, f: (cleanup(s, f), sys.exit(0)))  # type: ignore[misc]

    try:
        while True:
            s_code = server_proc.poll()
            w_code = web_proc.poll()
            if frpc_proc is not None:
                f_code = frpc_proc.poll()
                if f_code is not None and not shutting_down:
                    remove_frpc_url_file(worktree_name)
                    if f_code != 0:
                        print(f"[frpc] Tunnel exited with code {f_code}.", file=sys.stderr)
                    frpc_proc = None
            if s_code is not None:
                cleanup()
                sys.exit(s_code)
            if w_code is not None:
                cleanup()
                sys.exit(w_code)
            time.sleep(0.25)
    finally:
        cleanup()


if __name__ == "__main__":
    main()
