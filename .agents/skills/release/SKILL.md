---
name: release
description: Cut an Olive CalVer release (tag, GHCR image, GitHub release). Use when releasing Olive, tagging a version, publishing the Docker image, or previewing release notes.
---

# Olive release runbook

Releases are CalVer tags (`YYYY.MM.DD`, optional `.N` same-day counter, no `v`
prefix) pushed to `main`. Pushing a tag runs CI, publishes the multi-arch
image to GHCR (`:<tag>` + `:latest`), and creates a GitHub release whose notes
come from `CHANGELOG.md`. Full pipeline definition lives in
`.github/workflows/docker-publish.yml`; runbook policy in `AGENTS.md`.

Run the bundled scripts from this skill directory (`scripts/`). They resolve
the repo root via git, so they work from any checkout of this repo.

## Normal release

1. Land everything for the release on `main` first. The tag must point at
   `origin/main` — never tag a feature branch or a dirty tree.
2. Make sure `CHANGELOG.md` has a `## [YYYY-MM-DD]` section for the tag date
   (the release notes are every section newer than the previous tag).
3. Preview the notes:
   `scripts/preview-notes.sh [TAG]` (defaults to today's UTC date).
4. Preflight: `scripts/check-release.sh [TAG]`. Fix anything it flags.
5. Cut: `scripts/cut-release.sh [TAG]` — runs preflight again, creates an
   annotated tag, and pushes it.
6. Follow the run (CI → publish → release) via `gh run watch` or the printed
   release URL, then confirm the image tags exist:
   `docker buildx imagetools inspect ghcr.io/<owner>/olive2:<TAG>`.

## Same-day follow-up

If a release is already out and a fix needs to ship the same day, tag
`YYYY.MM.DD.1` (then `.2`, …). Notes cover only the changelog sections newer
than the previous tag, so add a changelog entry for the fix under today's
heading before tagging.

## Fixing mistakes

- **Wrong tag name, workflow hasn't run yet:** delete it before CI picks it
  up — `git tag -d <TAG> && git push origin :refs/tags/<TAG>` — then re-cut.
- **Bad release already published:** do not rewrite the tag or hand-edit the
  release. Fix forward on `main` (changelog entry included) and cut the next
  tag (same-day `.N` suffix if needed).
- **CI failed on the tag:** fix on `main`, then delete the tag locally and on
  the remote (as above) and re-cut so the tag points at green `main`.
- **Notes look wrong:** the notes are generated, never hand-edited. Fix
  `CHANGELOG.md` / `scripts/release_notes.py` on `main`; for an already-cut
  release, ship the correction in the next tag.

## Manual (no-script) equivalent

```bash
git checkout main && git pull
# edit CHANGELOG.md, commit, push
git tag -a 2026.10.15 -m "Release 2026.10.15"
git push origin 2026.10.15
```
