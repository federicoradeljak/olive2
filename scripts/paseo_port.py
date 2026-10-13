#!/usr/bin/env python3
"""Deterministic, branch-stable port allocation for Olive and Paseo's servicePorts.portScript."""

from __future__ import annotations

import os
import re
import subprocess
import sys

DEFAULT_RANGE = "4470-4499"


def parse_range(spec: str) -> tuple[int, int]:
    m = re.match(r"^\s*(\d+)\s*-\s*(\d+)\s*$", spec)
    if not m:
        raise ValueError(f'Invalid port range: "{spec}" (expected "START-END")')
    start, end = int(m.group(1)), int(m.group(2))
    if start < 1 or end > 65535 or end < start:
        raise ValueError(f'Invalid port range: "{spec}" (bounds must be 1-65535 and START <= END)')
    return start, end


def fnv1a_32(input_str: str) -> int:
    h = 0x811C9DC5
    for ch in input_str:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def current_git_branch() -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            return ""
        branch = proc.stdout.strip()
        return "" if branch == "HEAD" else branch
    except Exception:
        return ""


def allocate_port(service: str = "web", branch: str = "", range_spec: str | None = None) -> int:
    start, end = parse_range(range_spec or os.environ.get("PASEO_PORT_RANGE") or DEFAULT_RANGE)
    span = end - start + 1
    key = f"{service}@{branch}"
    return start + (fnv1a_32(key) % span)


def main() -> None:
    args = sys.argv[1:]
    arg_service = args[0] if len(args) >= 1 else None
    arg_branch = args[2] if len(args) >= 3 else None

    service = os.environ.get("PASEO_SCRIPTNAME") or arg_service or "web"
    branch = os.environ.get("PASEO_BRANCH_NAME") or arg_branch or current_git_branch()
    port = allocate_port(service=service, branch=branch)
    sys.stdout.write(str(port))


if __name__ == "__main__":
    main()
