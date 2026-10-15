#!/usr/bin/env bash
# Preflight checks for cutting an Olive CalVer release.
# Usage: check-release.sh [TAG]   (TAG defaults to today's UTC date as YYYY.MM.DD)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "${SKILL_DIR}" rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

TAG="${1:-$(date -u +%Y.%m.%d)}"
FAIL=0

fail() { echo "FAIL: $1" >&2; FAIL=1; }
pass() { echo "ok: $1"; }

# 1. Tag format: YYYY.MM.DD with optional .N same-day counter, no prefix.
if [[ "${TAG}" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$ ]]; then
  pass "tag '${TAG}' is valid CalVer"
else
  fail "tag '${TAG}' is not CalVer (expected YYYY.MM.DD with optional .N, no 'v' prefix)"
fi

# 2. Clean working tree — the tag must point at exactly what's on disk.
if [ -z "$(git status --porcelain)" ]; then
  pass "working tree is clean"
else
  fail "working tree has uncommitted changes — commit or stash first"
fi

# 3. On main and in sync with origin (releases cut from main only).
BRANCH="$(git branch --show-current)"
if [ "${BRANCH}" = "main" ]; then
  pass "on branch 'main'"
else
  fail "on branch '${BRANCH}' — releases are cut from 'main' only"
fi
git fetch origin main --quiet
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  pass "local main matches origin/main"
else
  fail "local main differs from origin/main — pull/push before tagging"
fi

# 4. Tag must not already exist, locally or on the remote.
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  fail "tag '${TAG}' already exists locally"
else
  pass "tag '${TAG}' is new locally"
fi
if git ls-remote --tags origin | grep -q "refs/tags/${TAG}$"; then
  fail "tag '${TAG}' already exists on origin"
else
  pass "tag '${TAG}' is new on origin"
fi

# 5. CHANGELOG.md should have a section for the tag date — it becomes the notes.
TAG_DATE="$(echo "${TAG}" | awk -F. '{printf "%s-%s-%s", $1, $2, $3}')"
if grep -q "^## \[${TAG_DATE}\]" CHANGELOG.md; then
  pass "CHANGELOG.md has a [${TAG_DATE}] section"
else
  echo "WARN: CHANGELOG.md has no [${TAG_DATE}] section — release notes fall back to the newest section" >&2
fi

# 6. CI green on main? Best-effort: only when `gh` is available.
if command -v gh >/dev/null 2>&1; then
  if gh run list --branch main --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null | grep -q '^success$'; then
    pass "latest CI run on main succeeded"
  else
    echo "WARN: latest CI run on main is not green — check 'gh run list --branch main'" >&2
  fi
else
  echo "WARN: 'gh' not installed — skipping CI status check" >&2
fi

if [ "${FAIL}" -ne 0 ]; then
  echo "preflight FAILED for '${TAG}'" >&2
  exit 1
fi
echo "preflight passed for '${TAG}'"
