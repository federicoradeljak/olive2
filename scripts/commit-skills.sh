# scripts/commit-skills.sh
[ -n "$(git status --porcelain -- .agents/skills)" ] || exit 0
LEFTHOOK=0 git commit --no-verify -qm "chore: refresh vendored skills" -- .agents/skills
touch .agents/skills/.needs-repush   # gitignored

