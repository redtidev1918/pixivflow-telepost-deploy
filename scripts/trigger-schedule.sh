#!/usr/bin/env bash
#
# Operator-only emergency schedule trigger.
#
# WHAT THIS IS FOR
#
# Production runs two independent external clocks (primary cron-job.org,
# secondary Cloudflare Cron) and both POST the same idempotent endpoint. This
# script is the THIRD, human-operated path: when both clocks are suspect and an
# occurrence must be replayed right now, an operator runs this by hand.
#
# It is deliberately NOT a clock. It computes nothing:
#   * it does not derive a slot id, an occurrence or a date
#   * it does not read or write any database or ledger
#   * it does not touch the Fly Machines API
#   * it does not call TelePost or hold any Telegram credential
# It resolves a schedule id and POSTs the same endpoint the clocks use. PixivFlow
# decides which occurrence that is and whether it already ran, so a manual replay
# converges on the same durable slot instead of starting a second one.
#
# SECRET HANDLING (this is the whole reason the script exists in this shape)
#
#   * the token is never passed in argv -- argv is world-readable through `ps`,
#     and it also lands in the shell history of anyone who types it inline;
#   * the token is never echoed, never logged, never written to a temp file;
#   * the request is built through `curl -K -` (a config file on stdin), so the
#     Authorization header exists only in this process's memory and a pipe;
#   * the token is read from a root-only file, or prompted for with `read -s`,
#     which does not echo and is not recorded in history.
#
# Usage:
#   ./scripts/trigger-schedule.sh bot1-daily
#   ./scripts/trigger-schedule.sh bot1-daily --dry-run
#
# Exit codes:
#   0  the trigger was admitted or had already converged (accepted / running / completed)
#   1  the trigger was refused or failed (401/404/410/425/429/5xx/timeout/rejected)
#   2  usage or local configuration error (no schedule id, no token, unreachable host)
set -euo pipefail

repo_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo_dir" || exit 2

die() { echo "[FAIL] $*" >&2; exit 2; }
note() { echo "[INFO] $*"; }
ok() { echo "[OK] $*"; }
bad() { echo "[FAIL] $*" >&2; }

schedule_id=${1:-}
dry_run=${2:-}
[[ -n "$schedule_id" ]] || die "usage: $0 <scheduleId> [--dry-run]"
[[ "$schedule_id" == "--"* ]] && die "usage: $0 <scheduleId> [--dry-run]"
case "$dry_run" in ''|--dry-run) ;; *) die "unknown argument: $dry_run";; esac

# --- the schedule id must be one the executor actually declares -----------------
#
# Read from the authority (the executor's own production config), never from a
# list kept here: a hard-coded copy is how a schedule id silently stops existing.
config=pixivflow/config/production.json
[[ -f "$config" ]] || die "missing $config"
known_ids_raw=$(python3 -c 'import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    config = json.load(handle)
for schedule in config.get("schedules", []):
    if schedule.get("enabled"):
        print(schedule["id"])' "$config")
known_ids=()
while IFS= read -r line; do
  [[ -n "$line" ]] && known_ids+=("$line")
done <<< "$known_ids_raw"
[[ ${#known_ids[@]} -gt 0 ]] || die "$config declares no enabled schedule"

known=0
for id in "${known_ids[@]}"; do [[ "$id" == "$schedule_id" ]] && known=1; done
if [[ "$known" -ne 1 ]]; then
  die "unknown schedule '$schedule_id'; declared: ${known_ids[*]}"
fi
ok "schedule '$schedule_id' is declared and enabled in $config"

# --- endpoint -------------------------------------------------------------------
#
# The base URL has exactly one statement in this repo: the clock's wrangler.toml.
# Reading it here instead of repeating it keeps the two from drifting.
base_url=${PIXIVFLOW_TRIGGER_BASE_URL:-}
if [[ -z "$base_url" ]]; then
  #
# `awk -F'"'` rather than a python heredoc: macOS ships bash 3.2, which
# mis-parses a heredoc nested inside a command substitution.
base_url=$(awk -F'"' '/^[[:space:]]*PIXIVFLOW_TRIGGER_BASE_URL[[:space:]]*=/{print $2; exit}' control-plane/wrangler.toml)
fi
[[ -n "$base_url" ]] || die "cannot determine the trigger origin; set PIXIVFLOW_TRIGGER_BASE_URL"
base_url=${base_url%/}
case "$base_url" in
  https://*) ;;
  *) die "trigger origin must be https:// (got a non-https origin)" ;;
esac
note "trigger origin: $base_url"

# --- token ----------------------------------------------------------------------
#
# Priority: an explicit file, else the conventional root-only path, else a hidden
# prompt. There is deliberately NO environment-variable path: an exported token
# leaks into the environment of every child process and shows up in `ps e`.
token_file=${SCHEDULER_TRIGGER_TOKEN_FILE:-/etc/pixivflow/scheduler-trigger-token}
token=""
if [[ -n "${SCHEDULER_TRIGGER_TOKEN_FILE:-}" && ! -f "$token_file" ]]; then
  die "SCHEDULER_TRIGGER_TOKEN_FILE=$token_file does not exist"
fi

if [[ -f "$token_file" ]]; then
  perms=$(python3 -c 'import os,stat,sys;p=os.stat(sys.argv[1]).st_mode;print(oct(stat.S_IMODE(p))[2:])' "$token_file")
  case "$perms" in
    600|400) ok "reading the token from $token_file (mode $perms)" ;;
    *) bad "refusing to read $token_file: mode $perms, expected 400 or 600"
       bad "run: chmod 600 $token_file"
       exit 2 ;;
  esac
  IFS= read -r token < "$token_file" || true
  token=${token%$'\r'}
  token=${token%$'\n'}
else
  note "no token file at $token_file; prompting (input is not echoed, not recorded in history)"
  if [[ ! -t 0 ]]; then
    die "no token file and no terminal to prompt on; create $token_file (mode 600) first"
  fi
  read -r -s -p "SCHEDULER_TRIGGER_TOKEN: " token
  echo
fi
[[ -n "$token" ]] || die "the token is empty"

# --- preflight ------------------------------------------------------------------
#
# The only safe liveness probe. /health does not require the token, and it starts
# a STOPPED executor Machine like any other request (auto_start_machines = true),
# so this is deliberately a single check, never a polling loop.
health_url="${base_url}/health"
http_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "$health_url" || echo 000)
case "$http_code" in
  200) ok "executor reachable ($health_url -> 200)" ;;
  000) bad "executor unreachable ($health_url): network failure, proxy or DNS"
       exit 2 ;;
  *) bad "executor answered $http_code on $health_url"
     exit 2 ;;
esac

if [[ "$dry_run" == "--dry-run" ]]; then
  ok "dry run complete: schedule id valid, origin reachable, token loaded"
  note "would POST ${base_url}/internal/schedules/${schedule_id}/run"
  note "not sending anything"
  exit 0
fi

# --- the trigger ----------------------------------------------------------------
#
# Built through `curl -K -` so no secret reaches argv, and sent with NO body: the
# executor resolves the occurrence from the schedule's own cron, so a body could
# only supply decoration, and a body would need its JSON quoting escaped inside
# the curl config. Provenance travels in the two headers instead.
#
# Because the request names no date, it cannot back-fill history or point at a
# stale occurrence.
attempt_id="manual-$(date -u +%Y%m%dT%H%M%SZ)-$$"
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

http_code=$(
  {
    printf 'header = "authorization: Bearer %s"\n' "$token"
    printf 'header = "x-schedule-provider: manual"\n'
    printf 'header = "x-schedule-attempt-id: %s"\n' "$attempt_id"
    printf 'request = "POST"\n'
    printf 'url = "%s/internal/schedules/%s/run"\n' "$base_url" "$schedule_id"
    printf 'max-time = "120"\n'
    printf 'silent\nshow-error\n'
  } | curl -K - -o "$response_file" -w '%{http_code}' || echo 000
)

note "attempt id: $attempt_id"

disposition=$(python3 -c 'import json, sys
try:
    body = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    body = {}
print(body.get("note") or body.get("status") or "")' "$response_file")

case "$http_code" in
  200) ok "HTTP 200, disposition=${disposition:-completed}: this occurrence was already completed" ;;
  202) ok "HTTP 202, disposition=${disposition:-accepted}: admitted (accepted) or already running (already_running)" ;;
  401) bad "HTTP 401: the trigger token is wrong or missing at the executor"; exit 1 ;;
  404) bad "HTTP 404: the executor does not declare schedule '$schedule_id'"; exit 1 ;;
  410) bad "HTTP 410: the occurrence has expired; the grace window has passed"; exit 1 ;;
  425) bad "HTTP 425: the occurrence is not due yet"; exit 1 ;;
  429) bad "HTTP 429: throttled; retry later"; exit 1 ;;
  503) bad "HTTP 503: rejected by the executor (see its schedule.trigger_rejected log line)"; exit 1 ;;
  000) bad "no HTTP response: timeout or network failure"; exit 1 ;;
  5??) bad "HTTP $http_code: executor error (see its schedule.trigger_error log line)"; exit 1 ;;
  *)   bad "unexpected HTTP $http_code (disposition=${disposition:-none})"; exit 1 ;;
esac

note "next: read the executor's schedule.trigger_* line for attempt_id $attempt_id"
note "then read schedule.outcome for the slot this attempt resolved to"
exit 0
