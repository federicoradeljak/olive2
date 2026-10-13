from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from frpc import (  # noqa: E402
    FrpcEndpoint,
    FrpcProxyOptions,
    build_frpc_args,
    build_frpc_endpoint,
    build_frpc_subdomain,
    build_frpc_url,
    get_frpc_url_file_path,
    parse_frpc_server_port,
    read_frpc_url_file,
    remove_frpc_url_file,
    repository_name_from_remote,
    sanitize_dns_label,
    write_frpc_url_file,
)


def test_extracts_repository_names_from_common_git_remotes() -> None:
    assert repository_name_from_remote("https://github.com/mcowger/olive.git") == "olive"
    assert repository_name_from_remote("git@github.com:mcowger/olive.git") == "olive"
    assert repository_name_from_remote("https://github.com/mcowger/olive/") == "olive"


def test_creates_dns_safe_deterministic_subdomain() -> None:
    subdomain = build_frpc_subdomain("Olive", "feature/auth login")
    assert subdomain == "olive-feature-auth-login"
    assert build_frpc_subdomain("Olive", "feature/auth login") == subdomain


def test_keeps_long_subdomains_within_dns_label_limit() -> None:
    subdomain = build_frpc_subdomain("olive", "a" * 100)
    assert len(subdomain) <= 63
    assert subdomain.startswith("olive-a")
    assert len(subdomain.split("-")[-1]) == 8


def test_uses_fallback_for_empty_dns_labels() -> None:
    assert sanitize_dns_label("---", "fallback") == "fallback"


def test_builds_cli_only_http_proxy_arguments() -> None:
    args = build_frpc_args(
        FrpcProxyOptions(
            server_addr="192.168.0.2",
            server_port=7000,
            token="secret",
            proxy_name="olive-worktree",
            local_port=4480,
            subdomain="olive-worktree",
        )
    )
    assert args == [
        "http",
        "--server-addr",
        "192.168.0.2",
        "--server-port",
        "7000",
        "--token",
        "secret",
        "--proxy-name",
        "olive-worktree",
        "--local-ip",
        "127.0.0.1",
        "--local-port",
        "4480",
        "--sd",
        "olive-worktree",
    ]


def test_builds_full_url_only_when_host_is_configured() -> None:
    assert (
        build_frpc_url("olive-wild-lynx", "dev.home.cowger.us")
        == "https://olive-wild-lynx.dev.home.cowger.us"
    )
    assert build_frpc_url("olive-wild-lynx") is None


def test_builds_same_endpoint_used_by_dev_lifecycle() -> None:
    assert build_frpc_endpoint("Olive", "wild-lynx", "dev.home.cowger.us") == FrpcEndpoint(
        subdomain="olive-wild-lynx",
        url="https://olive-wild-lynx.dev.home.cowger.us",
    )


def test_writes_and_removes_url_file() -> None:
    wt = f"frpc-test-{os.getpid()}"
    url = "https://olive-wild-lynx.dev.home.cowger.us"
    file_path = get_frpc_url_file_path(wt)
    try:
        write_frpc_url_file(url, wt)
        assert Path(file_path).read_text(encoding="utf-8") == f"{url}\n"
        assert read_frpc_url_file(wt) == url

        remove_frpc_url_file(wt)
        assert not Path(file_path).exists()
        assert read_frpc_url_file(wt) is None
    finally:
        remove_frpc_url_file(wt)


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, 7000),
        ({"FRPC_SERVER_PORT": "7443"}, 7443),
        ({"FRPC_SERVER_PORT": "0"}, None),
        ({"FRPC_SERVER_PORT": "70000"}, None),
        ({"FRPC_SERVER_PORT": "abc"}, None),
    ],
)
def test_parses_frpc_server_port(env: dict[str, str], expected: int | None) -> None:
    assert parse_frpc_server_port(env) == expected
