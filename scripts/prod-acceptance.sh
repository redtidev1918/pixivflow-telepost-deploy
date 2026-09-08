#!/usr/bin/env bash
# Production acceptance for the Fly-autosleep external-clock deployment.
# READ-ONLY: does NOT POST any schedule trigger. It only wakes the machine (an
# SSH/health wake never runs a scheduled Slot in external mode) and runs read-only
# SELECTs against the PixivFlow + TelePost SQLite DBs.
#
# Run AFTER the first real occurrence (e.g. 2026-09-09 after 10:30 Beijing):
#   scripts/prod-acceptance.sh                  # default app, today (Asia/Shanghai)
#   APP=myapp DATE=2026-09-09 scripts/prod-acceptance.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${APP:-telesubmit-multi-bot}"
DATE="${DATE:-$(TZ=Asia/Shanghai date +%F)}"
MID="${MID:-}"

echo "==> App=$APP  Date(Asia/Shanghai)=$DATE  (read-only, NO trigger)"
echo "==> Machine state (before)"
fly status -a "$APP" | grep -E "PROCESS|app |stopped|started" || true

if [ -z "$MID" ]; then
  MID=$(fly machines list -a "$APP" --json 2>/dev/null | \
    python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["id"] if d else "")' 2>/dev/null || true)
fi
if [ -n "$MID" ]; then
  fly machine start "$MID" -a "$APP" >/dev/null 2>&1 || true
  echo "==> Woke machine $MID; waiting for boot..."
  sleep 25
fi

B64=$(base64 < "$HERE/prod-acceptance.query.js" | tr -d '\n')
fly ssh console -a "$APP" --command "sh -c 'echo $B64 | base64 -d > /tmp/accept.js && node /tmp/accept.js $DATE'" 2>&1 \
  | grep -v "^Connecting" | grep -v "^\]8;;"

echo
echo "==> Health / memory (system_available_mb; low = OOM risk)"
curl -s --max-time 45 "https://$APP.fly.dev/health" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  print("  available_mb:", d.get("system_available_mb"))
  print("  node_rss_mb:", [p.get("rss_mb") for p in d.get("process_rss",[]) if p.get("name")=="node"])
except Exception as e:
  print("  (health not reachable yet / mid-wake):", e)' || true

echo
echo "==> GitHub watchdog runs (expect already_completed/200 after the primary ran):"
echo "    gh run list --repo redtidev1918/pixivflow-telepost-deploy --workflow schedule-watchdog --limit 4"
echo "==> Machine auto-stops when idle; manual: fly status -a $APP / fly machine stop $MID -a $APP"
