#!/usr/bin/env bash
#
# Session-independent window checkpoint for one schedule occurrence.
#
# WHAT IT IS FOR
#
# This is the human fallback made deterministic. At a fixed UTC instant it asks
# one question: "did this occurrence get admitted before the checkpoint?" — and
# answers it ONLY from durable evidence (executor admission logs + ledger
# snapshots the watcher already captured). It never probes the executor, never
# starts a Machine, never computes an occurrence.
#
# If the evidence shows the occurrence WAS admitted (accepted / already_running /
# already_completed, or a durable slot row), it records which clock won. If
# neither clock left any trace, it runs the operator-only idempotent trigger
# (`scripts/trigger-schedule.sh`) exactly once as the third, human path, the same
# way the runbook prescribes. The result of that attempt — including "refused"
# and "no token provisioned" — is recorded verbatim in the checkpoint file.
#
# Token handling: the token is ONLY read by scripts/trigger-schedule.sh from the
# operator-provisioned root-only file (or stdin prompt). This script never sees,
# echoes, logs, or env-exports the token. If no token file exists, the trigger
# attempt fails with exit 2 and the checkpoint records RECOVERY_NEEDED with the
# exact operator command; it does NOT fake a success.
#
# Usage:
#   ./scripts/checkpoint-window.sh bot1-daily   # default window = 14:07Z
#   ./scripts/checkpoint-window.sh bot2-daily   # default window = 14:17Z
#   ./scripts/checkpoint-window.sh bot1-daily --at 14:07Z --out <dir>
#
# Exit codes:
#   0  occurrence admitted by a clock BEFORE the checkpoint (no trigger fired)
#   3  trigger was fired by this script (manual fallback path)
#   4  admission evidence found but ambiguous (recorded for human review)
#   5  no admission evidence and the trigger attempt refused/unavailable
#   6  local configuration error (unknown schedule, bad args, missing repo)
set -uo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir" || exit 6

schedule_id=""
at_arg=""
out_dir=""
watch_dir="${WATCH_EVIDENCE_DIR:-$repo_dir/evidence/2026-09-13/watcher}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --at) at_arg=${2:-}; shift 2 ;;
    --out) out_dir=${2:-}; shift 2 ;;
    --watch-dir) watch_dir=${2:-}; shift 2 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) schedule_id=$1; shift ;;
  esac
done

[[ -n "$schedule_id" ]] || { echo "[FAIL] usage: $0 <bot1-daily|bot2-daily> [--at HH:MMZ] [--out DIR]" >&2; exit 6; }
case "$schedule_id" in
  bot1-daily|bot2-daily) ;;
  *) echo "[FAIL] unknown schedule '$schedule_id'; expected bot1-daily or bot2-daily" >&2; exit 6 ;;
esac

# The moment this script must be able to act, not when it must start. It sleeps
# until the checkpoint instant, so a checkpoint launched hours early is fine.
# (macOS ships bash 3.2: no associative arrays, so this is a case, not a map.)
cp_epoch=""
case "$schedule_id" in
  bot1-daily) cp_epoch=$(python3 -c 'import calendar,datetime;print(calendar.timegm(datetime.datetime(2026,9,13,14,7,0).timetuple()))') ;;
  bot2-daily) cp_epoch=$(python3 -c 'import calendar,datetime;print(calendar.timegm(datetime.datetime(2026,9,13,14,17,0).timetuple()))') ;;
esac
if [[ -n "$at_arg" ]]; then
  cp_epoch=$(python3 - "$at_arg" <<'PY'
import datetime, sys
raw = sys.argv[1]
fmt = "%H:%MZ" if raw.count(":") == 1 else "%Y-%m-%dT%H:%MZ"
tz = datetime.timezone.utc
parsed = datetime.datetime.strptime(raw, fmt).replace(tzinfo=tz)
print(int(parsed.timestamp()))
PY
)
fi

[[ -n "$out_dir" ]] || out_dir="${EVIDENCE_DIR:-$repo_dir/evidence/2026-09-13/checkpoints}"
mkdir -p "$out_dir"

# Belt and braces: this script must never turn a proxy var into a write.
export ALL_PROXY='' all_proxy='' http_proxy='' https_proxy='' NO_PROXY='*'

out_file="$out_dir/checkpoint-${schedule_id}.txt"
log_file="$out_dir/checkpoint-${schedule_id}.log"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$log_file"; }

now_epoch=$(date -u +%s)
if (( now_epoch < cp_epoch )); then
  say "sleeping until checkpoint instant $cp_epoch ($(( cp_epoch - now_epoch ))s)"
  sleep $(( cp_epoch - now_epoch ))
fi
say "checkpoint time reached; schedule=$schedule_id"

# --- evidence: admission lines in the watcher's captured executor log -----------
admission_file="$watch_dir/executor.log"
admission_hits=""
if [[ -s "$admission_file" ]]; then
  admission_hits=$(grep -aE 'schedule\.trigger_(accepted|already_running|already_completed)' "$admission_file" \
    | grep -a "$schedule_id" | tail -5 || true)
fi

# --- evidence: durable slot row in the ledger snapshots -------------------------
ledger_file="$watch_dir/ledger.txt"
slot_hits=""
if [[ -s "$ledger_file" ]]; then
  slot_hits=$(grep -a "$schedule_id" "$ledger_file" | grep -aiE 'slot|occurrence' | tail -5 || true)
fi

say "admission evidence: $([ -n "$admission_hits" ] && echo PRESENT || echo none)"
say "ledger evidence:    $([ -n "$slot_hits" ] && echo PRESENT || echo none)"

if [[ -n "$admission_hits" || -n "$slot_hits" ]]; then
  {
    echo "CHECKPOINT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "SCHEDULE=$schedule_id"
    echo "ADMISSION_EVIDENCE=$([ -n "$admission_hits" ] && echo yes || echo no)"
    echo "LEDGER_EVIDENCE=$([ -n "$slot_hits" ] && echo yes || echo no)"
    echo "MANUAL_FALLBACK=fired_no"
    echo "RESULT=ADMITTED_BEFORE_CHECKPOINT"
    if [[ -n "$admission_hits" ]]; then echo "--- admission lines ---"; printf '%s\n' "$admission_hits"; fi
    if [[ -n "$slot_hits" ]]; then echo "--- slot lines ---"; printf '%s\n' "$slot_hits"; fi
  } > "$out_file"
  say "occurrence already admitted; no manual trigger. -> $out_file"
  exit 0
fi

# --- neither clock left a trace: run the operator fallback exactly once ---------
say "no admission and no slot evidence; firing operator trigger for $schedule_id"
trigger_rc=0
trigger_out=""
trigger_out=$(bash scripts/trigger-schedule.sh "$schedule_id" 2>&1) || trigger_rc=$?
say "trigger-schedule.sh exit=$trigger_rc"
say "$trigger_out" | sed 's/^/    /'

{
  echo "CHECKPOINT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "SCHEDULE=$schedule_id"
  echo "ADMISSION_EVIDENCE=no"
  echo "LEDGER_EVIDENCE=no"
  echo "MANUAL_FALLBACK=fired_yes"
  echo "MANUAL_FALLBACK_EXIT=$trigger_rc"
  echo "--- trigger-schedule.sh output (sanitised) ---"
  printf '%s\n' "$trigger_out" | sed -E 's/(Bearer )[A-Za-z0-9._-]+/\1[redacted]/g'
} > "$out_file"
say "checkpoint recorded -> $out_file"

case "$trigger_rc" in
  0) say "RESULT=RECOVERED_MANUALLY"; exit 3 ;;
  2) say "RESULT=RECOVERY_NEEDED (local config: missing token file or repo); operator must run:"
     say "    sudo mkdir -p /etc/pixivflow && sudo sh -c 'umask 077 && echo -n <token> > /etc/pixivflow/scheduler-trigger-token'"
     say "    bash scripts/trigger-schedule.sh $schedule_id"
     exit 5 ;;
  *) say "RESULT=RECOVERY_NEEDED (trigger refused: exit $trigger_rc)"; exit 5 ;;
esac