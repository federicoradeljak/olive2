#!/usr/bin/env bash
# Preview the GitHub release notes a CalVer tag would produce.
# Usage: preview-notes.sh [TAG]   (TAG defaults to today's UTC date as YYYY.MM.DD)
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "${SKILL_DIR}" rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

TAG="${1:-$(date -u +%Y.%m.%d)}"
IMAGE="ghcr.io/$(git remote get-url origin | sed -E 's#.*github.com[:/]([^.]+)(\.git)?#\1#')"

# Same previous-tag resolution as .github/workflows/docker-publish.yml:
# newest CalVer tag strictly older than TAG by version sort (empty = first release).
# TAG itself is included in the sort so the lookup also works before the tag
# exists (i.e. when previewing a release that hasn't been cut yet).
mapfile -t CALVER_TAGS < <(git tag --list | grep -E '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$' || true)
PREV=""
if [ "${#CALVER_TAGS[@]}" -gt 0 ]; then
  PREV="$(printf '%s\n' "${CALVER_TAGS[@]}" "${TAG}" | sort -V -u | awk -v tag="${TAG}" '{ if ($0 == tag) { print prev; exit } prev = $0 }')"
fi

ARGS=(--tag "${TAG}" --image "${IMAGE}")
if [ -n "${PREV}" ]; then
  ARGS+=(--prev-tag "${PREV}")
  echo "# preview: notes for ${TAG} (changes since ${PREV})" >&2
else
  echo "# preview: notes for ${TAG} (no previous tag — full changelog)" >&2
fi

python3 scripts/release_notes.py "${ARGS[@]}"
