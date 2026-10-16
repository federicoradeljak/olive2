# scripts/skills-throttle.sh — exit 0 = fresh, skip the job
marker=.agents/skills/.last-refresh   # gitignored
[ -f "$marker" ] && [ $(( $(date +%s) - $(cat "$marker") )) -lt 604800 ]
