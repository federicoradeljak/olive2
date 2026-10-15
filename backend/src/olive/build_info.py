"""Runtime build identity (date/time/commit hash) shown instead of a version number.

Olive ships continuously with no releases, so a static version is meaningless.
The What's New modal and ``GET /api/changelog`` show when the running server
was built and from what commit, e.g. ``2026-10-15 14:32 UTC · 4d5ea70``.

Resolution order:
1. ``OLIVE_BUILD_SHA`` / ``OLIVE_BUILD_DATE`` environment variables, baked
   into the Docker image via build args (the image contains no ``.git``).
2. Local git ``HEAD`` (dev checkouts, tests).
3. ``"unknown build"`` fallback — never raises, so startup can't fail on this.
"""

from __future__ import annotations

import os
import subprocess
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path


def _env(name: str) -> str | None:
    return os.environ.get(name) or None


def _git_output(args: list[str]) -> str | None:
    """Run a git command against the enclosing checkout, if there is one."""
    candidates = [Path(__file__).resolve().parents[3], Path.cwd()]
    for cwd in candidates:
        if not (cwd / ".git").exists():
            continue
        try:
            proc = subprocess.run(
                ["git", *args],
                cwd=cwd,
                text=True,
                capture_output=True,
                check=False,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    return None


def _format_date(raw: str) -> str:
    """Normalize an ISO-8601 timestamp to ``YYYY-MM-DD HH:MM UTC``.

    Returns the raw string unchanged when it can't be parsed.
    """
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(UTC)
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except ValueError:
        return raw


@lru_cache(maxsize=1)
def get_build_info() -> dict[str, str | None]:
    """Return ``{"sha": ..., "date": ...}`` for the running build."""
    sha = _env("OLIVE_BUILD_SHA") or _git_output(["rev-parse", "HEAD"])
    raw_date = _env("OLIVE_BUILD_DATE") or _git_output(["log", "-1", "--format=%cI"])
    return {"sha": sha, "date": _format_date(raw_date) if raw_date else None}


def get_build_display() -> str:
    """Human-readable build identity, e.g. ``2026-10-15 14:32 UTC · 4d5ea70``."""
    info = get_build_info()
    sha = (info["sha"] or "").strip()
    short_sha = sha[:7] if len(sha) > 7 else sha
    date = (info["date"] or "").strip()
    if date and short_sha:
        return f"{date} · {short_sha}"
    return short_sha or date or "unknown build"
