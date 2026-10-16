# scripts/refresh-skills.sh — marker advances only on success
skills update -y && date +%s > .agents/skills/.last-refresh
