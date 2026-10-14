#!/usr/bin/env bash
# Mobile/iPad viewport audit for the Olive UI.
# Usage: start the dev stack first (python3 scripts/dev.py), then:
#   OLIVE_URL=http://127.0.0.1:5187 bash scripts/mobile_audit.sh [outdir]
# Checks per viewport: horizontal overflow, <44px tappables, <16px form controls.
# Screenshots land in <outdir> (default /tmp/olive-mobile-shots).
set -u
URL="${OLIVE_URL:-http://127.0.0.1:5173}"
OUT="${1:-/tmp/olive-mobile-shots}"
mkdir -p "$OUT"
export AGENT_BROWSER_SESSION="${AGENT_BROWSER_SESSION:-olive-mobile-audit}"
cd "$OUT"

check() { # name width height path
  agent-browser set viewport "$2" "$3" >/dev/null 2>&1
  agent-browser open "$URL$4" >/dev/null 2>&1
  agent-browser wait 1600 >/dev/null 2>&1
  agent-browser screenshot "$OUT/$1.png" >/dev/null 2>&1
  echo "--- $1 ${2}x${3} $4"
  agent-browser eval "(()=>{const de=document.documentElement;const els=[...document.querySelectorAll('button,a,input,select,textarea')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'});const small=els.filter(e=>e.getBoundingClientRect().height<44);const zoom=[...document.querySelectorAll('input,select,textarea')].filter(e=>parseFloat(getComputedStyle(e).fontSize)<16);return JSON.stringify({overflowX:de.scrollWidth>innerWidth,scrollW:de.scrollWidth,w:innerWidth,scrollH:de.scrollHeight,interactive:els.length,under44:small.length,zoomRisk:zoom.length})})()" 2>&1 | tail -1
}

MID="$(curl -s "${URL%/}/api/meetings" 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);ms=d.get("meetings",[]);print(ms[0]["id"] if ms else "")' 2>/dev/null || echo '')"
# Vite proxies /api, so the call above works against the frontend origin too.
for vp in "390 844" "360 800" "430 932" "820 1180" "1180 820"; do
  set -- $vp
  check "w$1-meetings" "$1" "$2" /meetings
  check "w$1-people" "$1" "$2" /people
  check "w$1-usage" "$1" "$2" /usage
  [ -n "$MID" ] && check "w$1-detail" "$1" "$2" "/meetings/$MID"
done
echo "Screenshots in $OUT"
