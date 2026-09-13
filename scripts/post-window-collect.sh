#!/usr/bin/env bash
# READ-ONLY post-window evidence collector (session-independent).
#
# Runs once at ~14:14Z on 2026-09-13, after the second 22:12 CST occurrence.
# It never starts a Machine, never POSTs a trigger, never writes a ledger row,
# never calls Telegram. If the executor Machine is stopped, it does NOT wake it:
# the watcher already snapshotted the ledger during the live run.
#
# Usage: post-window-collect.sh <evidence-root>
set -uo pipefail
export ALL_PROXY='' all_proxy='' http_proxy='' https_proxy='' NO_PROXY='*'

ROOT="${1:-$HOME/pixivflow-evidence/2026-09-13}"
REPO="$HOME/Documents/code/pixivflow-telepost-deploy"
WATCH="$ROOT/watcher"
OUT="$ROOT/post-window"
mkdir -p "$WATCH/events" "$OUT"
LOG="$OUT/collector.log"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }

target_epoch=$(python3 -c 'import calendar,datetime;print(calendar.timegm(datetime.datetime(2026,9,13,14,14,0).timetuple()))')
now=$(date -u +%s)
if (( target_epoch > now )); then
  sleep $(( target_epoch - now ))
fi
say "collector starting (read-only); root=$ROOT"

# `fly ssh console` bootstraps a fresh WireGuard tunnel per call; the first
# attempt can time out on the DNS probe while the very next call succeeds
# (measured 2026-09-13). Retrying transport-only avoids throwing away the
# post-window evidence over one transient timeout. The probes themselves run
# once per successful attempt and are strictly read-only.
ssh_console() {
  local app=$1 cmd=$2 out_file=$3 stdin_file=${4:-} attempt=0 rc=1
  while (( attempt < 5 )); do
    attempt=$((attempt + 1))
    if [[ -n "$stdin_file" ]]; then
      fly ssh console -a "$app" -C "$cmd" < "$stdin_file" > "$out_file" 2>&1
    else
      fly ssh console -a "$app" -C "$cmd" > "$out_file" 2>&1
    fi
    rc=$?
    if (( rc == 0 )) && ! grep -qE 'tunnel unavailable|i/o timeout' "$out_file"; then
      return 0
    fi
    sleep 5
  done
  return "$rc"
}

say "== TelePost submission ledger (both bots, 2026-09-13) =="
ssh_console telesubmit-multi-bot "sh -c 'python3 - 2026-09-13'" "$OUT/telepost.txt" \
  "$REPO/scripts/telepost-submission-probe.py"
say "telepost probe exit=$? -> $OUT/telepost.txt"

state=$(fly machine list -a pixivflow-scheduler --json 2>/dev/null | python3 -c 'import json,sys
try: m=json.load(sys.stdin)
except Exception: print("unknown"); raise SystemExit
print(m[0]["state"] if m else "none")')
say "executor state=$state"
if [[ "$state" == "started" ]]; then
  ssh_console pixivflow-scheduler "sh -c 'python3 /app/scripts/schedule-ledger-probe.py'" "$OUT/ledger-post.txt"
  say "post-window ledger snapshot exit=$? -> $OUT/ledger-post.txt"
else
  say "executor not running -> NOT waking it; relying on watcher snapshots"
fi

say "== executor logs (no-tail) =="
fly logs -a pixivflow-scheduler --no-tail > "$OUT/executor-post.log" 2>&1
say "executor logs exit=$? -> $OUT/executor-post.log"

# Derive the focused evidence views the acceptance wants. These are greps over
# the already-captured read-only logs, not new production calls.
{
  grep -aE 'trigger_received|trigger_accepted|trigger_already_running|trigger_already_completed|trigger_rejected|"provider"|x-schedule-provider' \
    "$WATCH/executor.log" "$OUT/executor-post.log" 2>/dev/null
} > "$OUT/admission.txt"
{
  grep -a 'schedule\.outcome' "$WATCH/executor.log" "$OUT/executor-post.log" 2>/dev/null
} > "$OUT/outcome.txt"
{
  echo "### watcher event timeline (derived from executor.log + watch.log)"
  grep -aE 'schedule\.|trigger_|provider|occurrence|slot' "$WATCH/executor.log" 2>/dev/null
  echo "### watcher state transitions"
  grep -aE 'WAKE|baseline|classification|ledger snapshot|deadline|Machine' "$WATCH/watch.log" 2>/dev/null
} > "$WATCH/events/timeline"
say "derived admission.txt / outcome.txt / events/timeline"

{
  echo "COLLECTOR_DONE_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "ROOT=$ROOT"
} > "$OUT/DONE.marker"
say "collector done"
