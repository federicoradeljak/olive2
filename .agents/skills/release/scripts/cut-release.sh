#!/usr/bin/env bash
# Cut an Olive CalVer release: preflight, annotated tag, push.
# Usage: cut-release.sh [TAG]   (TAG defaults to today's UTC date as YYYY.MM.DD)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "${SKILL_DIR}" rev-parse --show-toplevel)"

TAG="${1:-$(date -u +%Y.%m.%d)}"

"${SKILL_DIR}/scripts/check-release.sh" "${TAG}"

git -C "${REPO_ROOT}" tag -a "${TAG}" -m "Release ${TAG}"
git -C "${REPO_ROOT}" push origin "${TAG}"

echo ""
echo "Released ${TAG}."
echo "Watch it: CI runs, then the image publishes (ghcr.io :${TAG} + :latest),"
echo "then the GitHub release is created from the changelog."
if command -v gh >/dev/null 2>&1; then
  REPO="$(git -C "${REPO_ROOT}" remote get-url origin | sed -E 's#.*github.com[:/]([^.]+)(\.git)?#\1#')"
  echo "  gh run watch --repo ${REPO}   # CI + publish progress"
  echo "  https://github.com/${REPO}/releases/tag/${TAG}"
else
  echo "Install 'gh' or open the Actions tab to follow progress."
fi
