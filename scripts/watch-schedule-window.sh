#!/usr/bin/env bash
#
# Read-only watcher for one schedule occurrence window.
#
# WHAT IT IS FOR
#
# Tonight's acceptance is "did the occurrence actually run", and the answer must
# come from evidence, not from a feeling. This script waits for the executor
# Machine to be woken NATURALLY during the expected trigger window, then captures
# the boot logs and a read-only ledger snapshot before the Machine exits.
#
# WHAT IT WILL NEVER DO
#
#   * never start a Machine (no Machines API write, no `fly machine start`)
#   * never POST a trigger, never call the scheduler endpoint
#   * never write a ledger row, never run SQL other than SELECT
#   * never deploy anything
#
# It only observes. If no wake happens inside the window, that absence is itself
# the evidence, and it is recorded as such.
#
# Usage:
#   ./scripts/watch-schedule-window.sh                     # default: next 10:00/10:10 CST window
#   ./scripts/watch-schedule-window.sh --deadline 14:30Z --out /tmp/window
#   ./scripts/watch-schedule-window.sh --out ./evidence
#
# Exit codes:
#   0  a wake was captured inside the trigger window (NATURAL_WAKE)
#   1  no wake inside the window by the deadline (NO_NATURAL_WAKE)
#   2  local configuration problem (fly CLI, network)
set -uo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir" || exit 2

app=${PIXIVFLOW_FLY_APP:-pixivflow-scheduler}
out_dir=${PIXIVFLOW_WATCH_OUT:-/tmp/schedule-window}
deadline_arg=""
primary_minute="00"      # PRIMARY clock minute for the daily occurrence (10:00 CST)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deadline) deadline_arg=${2:-}; shift 2 ;;
    --out) out_dir=${2:-}; shift 2 ;;
    --app) app=${2:-}; shift 2 ;;
    --primary-minute) primary_minute=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "[FAIL] unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v fly >/dev/null || { echo "[FAIL] fly CLI not found" >&2; exit 2; }
mkdir -p "$out_dir"

# Belt and braces: never let a proxy environment variable turn this into a write.
export ALL_PROXY='' all_proxy='' http_proxy='' https_proxy='' NO_PROXY='*'

log_file="$out_dir/watch.log"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log_file"; }

# --- the window -----------------------------------------------------------------
#
# Compute today's primary/secondary instants in UTC. The daily occurrence is
# 10:00 / 10:10 Asia/Shanghai = 02:00Z / 02:10Z (once per day, 2026-09-19+).
primary_epoch=$(python3 - "${primary_minute}" <<'PY'
import datetime, sys
minute = int(sys.argv[1])
tz = datetime.timezone(datetime.timedelta(hours=8))
now = datetime.datetime.now(tz)
candidates = [
    now.replace(hour=10, minute=minute, second=0, microsecond=0),
    now.replace(hour=10, minute=minute, second=0, microsecond=0) + datetime.timedelta(days=1),
]
chosen = next(c for c in candidates if c > now)
print(int(chosen.timestamp()))
PY
)
# The secondary offset has exactly one statement in this repo: the clock's own
# cron map. Reading it here instead of repeating it keeps the two from drifting --
# and an offset that drifts would make this watcher wait for the wrong window.
offset_minutes=$(sed -n 's/.*SECONDARY_OFFSET_MINUTES *= *\([0-9][0-9]*\).*/\1/p' control-plane/src/cron-map.ts | head -n 1)
[[ -n "$offset_minutes" ]] || { echo "[FAIL] cannot read SECONDARY_OFFSET_MINUTES from control-plane/src/cron-map.ts" >&2; exit 2; }
secondary_epoch=$((primary_epoch + offset_minutes * 60))

if [[ -n "$deadline_arg" ]]; then
  deadline=$(python3 - "$deadline_arg" <<'PY'
import datetime, sys
raw = sys.argv[1]
fmt = "%H:%MZ" if raw.count(":") == 1 else "%Y-%m-%dT%H:%MZ"
tz = datetime.timezone.utc
now = datetime.datetime.now(tz)
parsed = datetime.datetime.strptime(raw, fmt).replace(tzinfo=tz)
if parsed < now:
    parsed += datetime.timedelta(days=1)
print(int(parsed.timestamp()))
PY
)
else
  deadline=$((secondary_epoch + 3600))
fi

window_start=$((primary_epoch - 120))
window_end=$((secondary_epoch + 1800))

human() { python3 -c 'import datetime,sys;print(datetime.datetime.fromtimestamp(int(sys.argv[1]),datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))' "$1"; }

state() {
  fly machine list -a "$app" --json 2>/dev/null | python3 -c '
import json, sys
try:
    machines = json.load(sys.stdin)
except Exception:
    print("unknown"); raise SystemExit(0)
print(machines[0]["state"] if machines else "none")
'
}

logs_snapshot() {
  fly logs -a "$app" --no-tail >>"$out_dir/executor.log" 2>&1
}

# `fly ssh console` bootstraps a fresh WireGuard tunnel per call, and the first
# attempt can time out on the DNS probe even when the machine is healthy
# (measured 2026-09-13: the immediate next call succeeds). Without a retry, one
# transient timeout would silently drop the ledger snapshot inside the exact
# window this script exists to observe. The retry is transport-only: the SQL
# probe still runs once per successful attempt, never twice on the same slot.
# The probe opens SQLite mode=ro and only SELECTs.
ssh_console() {
  local attempt=0 out=""
  while (( attempt < 4 )); do
    attempt=$((attempt + 1))
    out=$(fly ssh console -a "$app" -C "sh -c 'python3 /app/scripts/schedule-ledger-probe.py'" 2>&1)
    if [[ -n "$out" ]] && ! grep -qE 'tunnel unavailable|i/o timeout' <<<"$out"; then
      printf '%s' "$out"
      return 0
    fi
    sleep 5
  done
  printf '%s' "$out"
  return 1
}

ledger_snapshot() {
  local label="$1"
  {
    echo
    echo "########## LEDGER SNAPSHOT [$label] $(date -u +%Y-%m-%dT%H:%M:%SZ) ##########"
    # Read-only: the probe opens SQLite with mode=ro and only SELECTs.
    ssh_console
  } >>"$out_dir/ledger.txt"
  say "ledger snapshot [$label] captured"
}

say "app=$app primary=$(human "$primary_epoch") secondary=$(human "$secondary_epoch") (+${offset_minutes}min)"
say "window=[$(human "$window_start"), $(human "$window_end")] deadline=$(human "$deadline")"

# --- baseline -------------------------------------------------------------------
#
# Start from a clean, PROVEN stopped state. If the Machine is already running the
# baseline is meaningless: a wake that happened before we started watching would
# look like no wake at all.
say "waiting for the Machine to be stopped so the baseline is clean (current: $(state))"
while :; do
  current=$(state)
  [[ "$current" == "stopped" ]] && break
  if (( $(date -u +%s) > window_start )); then
    say "still '$current' at the window edge; capturing anyway"
    break
  fi
  sleep 15
done
say "baseline state=$(state)"

# --- wait for the natural wake --------------------------------------------------
woke=0
while :; do
  now=$(date -u +%s)
  if (( now > deadline )); then
    break
  fi
  current=$(state)
  if [[ "$current" == "started" ]]; then
    woke=1
    woke_at=$(date -u +%s)
    say "WAKE DETECTED at $(human "$woke_at") (state=started)"
    logs_snapshot
    ledger_snapshot "t+0"
    break
  fi
  sleep 15
done

if (( woke == 0 )); then
  logs_snapshot
  {
    echo "RESULT=NO_NATURAL_WAKE"
    echo "APP=$app"
    echo "PRIMARY_AT=$(human "$primary_epoch")"
    echo "SECONDARY_AT=$(human "$secondary_epoch")"
    echo "DEADLINE=$(human "$deadline")"
  } >"$out_dir/result.txt"
  say "deadline reached with no wake; wrote $out_dir/result.txt"
  exit 1
fi

# --- follow the run to exit -----------------------------------------------------
if (( woke_at >= window_start && woke_at <= window_end )); then
  verdict=WAKE_INSIDE_WINDOW
else
  # The critical reasoning trap: this is what a random public request looks like,
  # and it is NOT evidence that a clock fired.
  verdict=WAKE_OUTSIDE_WINDOW
fi
say "wake classification: $verdict"

samples=0
while :; do
  current=$(state)
  samples=$((samples + 1))
  if [[ "$current" != "started" ]]; then
    say "Machine left 'started' (state=$current) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    break
  fi
  if (( samples > 180 )); then
    say "still running after ~60 minutes; stopping the sampling, not the Machine"
    break
  fi
  if (( samples % 8 == 0 )); then
    ledger_snapshot "t+$((samples * 20))s"
  fi
  sleep 20
done

logs_snapshot
ledger_snapshot final
{
  echo "RESULT=$verdict"
  echo "APP=$app"
  echo "PRIMARY_AT=$(human "$primary_epoch")"
  echo "SECONDARY_AT=$(human "$secondary_epoch")"
  echo "WAKE_AT=$(human "$woke_at")"
  echo "WINDOW=[$(human "$window_start"), $(human "$window_end")]"
} >"$out_dir/result.txt"

say "done. artifacts: $out_dir/executor.log $out_dir/ledger.txt $out_dir/result.txt"
# The Machine was never started, stopped or modified by this script.
exit 0
