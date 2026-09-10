#!/usr/bin/env bash
#
# Cutover preflight. READ-ONLY: this script never calls setWebhook and never writes
# to D1 or to Fly. It exists to answer one question before a single webhook moves:
# is it currently safe to cut over, and after a rollback has everything really gone
# back?
#
# Usage:
#   scripts/cutover-preflight.sh                     # expect TelePost to own the webhooks
#   EXPECT_OWNER=worker scripts/cutover-preflight.sh  # after the cutover (or after a rollback)
#
# Tokens and secrets come from the environment, never from disk:
#   TELEGRAM_BOT1_TOKEN / TELEGRAM_BOT2_TOKEN   (or --from-fly to read them off Fly)
#   CONTROL_PLANE_TOKEN                          (the control plane's bearer)
#
# Exit 0 = every gate holds. Non-zero = a specific gate failed; the failing line says
# which, and no webhook should move until it is resolved.

set -uo pipefail

WORKER=${WORKER:-https://pixivflow-control-plane.redtidev1918.workers.dev}
EXPECT_OWNER=${EXPECT_OWNER:-telepost}
TELEPOST_WEBHOOK_BASE=${TELEPOST_WEBHOOK_BASE:-https://telesubmit-multi-bot.fly.dev/webhook}
FLY_APP=${FLY_APP:-telesubmit-multi-bot}
CREDENTIAL_ALIAS=${CREDENTIAL_ALIAS:-pixiv-main}
GITHUB_REPO=${GITHUB_REPO:-redtidev1918/pixivflow-telepost-deploy}
GITHUB_WORKFLOW=${GITHUB_WORKFLOW:-pixivflow-batch.yml}

failures=0
ok()   { printf '  \033[32mok\033[0m   %-18s %s\n' "$1" "$2"; }
bad()  { printf '  \033[31mFAIL\033[0m %-18s %s\n' "$1" "$2"; failures=$((failures + 1)); }
note() { printf '  %-22s %s\n' "$1" "$2"; }

for tool in jq curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required"; exit 2; }
done

if [ "${1:-}" = "--from-fly" ]; then
  eval "$(flyctl ssh console -a "$FLY_APP" -C 'env' 2>/dev/null \
    | grep -E '^BOT[0-9]+_TOKEN=' | sed 's/^/export TELEGRAM_/')" || true
fi

secret=${CONTROL_PLANE_TOKEN:-}
auth=()
[ -n "$secret" ] && auth=(-H "authorization: Bearer $secret")

echo "== control plane"
status=$(curl -sS --max-time 15 "${auth[@]}" "$WORKER/api/status" 2>/dev/null || true)
if [ -z "$status" ] || [ "$(printf '%s' "$status" | jq -r '.now // empty' 2>/dev/null)" = "" ]; then
  bad health "/api/status did not answer with JSON from $WORKER"
fi

mode=$(printf '%s' "$status" | jq -r '.executionMode // "?"' 2>/dev/null)
if [ "$mode" = "shadow" ]; then ok mode "shadow: runners publish nothing"; else bad mode "expected shadow before cutover, got '$mode'"; fi

clock=$(printf '%s' "$status" | jq -r '.clock.state // "unknown"' 2>/dev/null)
age=$(printf '%s' "$status" | jq -r '.clock.ageMinutes // "?"' 2>/dev/null)
case "$clock" in
  ok)      ok clock "last sweep ${age}m ago" ;;
  unknown) ok clock "no sweep recorded yet (a fresh deploy has not proved its cron)" ;;
  *)       bad clock "last sweep ${age}m ago -> $clock" ;;
esac

# --- the gates that decide whether a webhook may move -----------------------------
open_exec=$(printf '%s' "$status" | jq -r '[.recentExecutions[]? | select(.status | IN("dispatching","dispatched","running"))] | length' 2>/dev/null)
if [ "$open_exec" = "0" ]; then
  ok open-exec "0 running executions"
else
  bad open-exec "${open_exec:-?} execution(s) still open; pause dispatch and wait for terminal"
fi

uncertain=$(printf '%s' "$status" | jq -r '.reviewsByStatus.uncertain // 0' 2>/dev/null)
if [ "$uncertain" = "0" ]; then
  ok reviews "0 uncertain"
else
  bad reviews "$uncertain uncertain review(s) need a human; each may or may not be in the channel"
fi
note reviews "$(printf '%s' "$status" | jq -rc '.reviewsByStatus // {}' 2>/dev/null)"

if printf '%s' "$status" | jq -e '.providerConfigured == true' >/dev/null 2>&1; then
  ok provider "GitHub dispatch configured"
else
  bad provider "no GitHub dispatch token/repo configured"
fi

ref=$(printf '%s' "$status" | jq -r '.pixivflowRef // empty' 2>/dev/null)
if command -v gh >/dev/null 2>&1 && [ -n "$ref" ]; then
  if gh api "repos/$GITHUB_REPO/contents/.github/workflows/$GITHUB_WORKFLOW?ref=$ref" >/dev/null 2>&1; then
    ok workflow "$GITHUB_WORKFLOW on $ref"
  else
    bad workflow "$GITHUB_WORKFLOW not found on $ref"
  fi
fi

echo "== credentials"
if [ -z "$secret" ]; then
  bad token "CONTROL_PLANE_TOKEN is not set; the D1 gates cannot be read"
else
  # The value is never printed: this is read-only, and its output ends up in a
  # transcript.
  read_body=$(curl -sS --max-time 20 -X POST "${auth[@]}" "$WORKER/control/credentials/$CREDENTIAL_ALIAS/read" 2>/dev/null || true)
  read_ok=$(printf '%s' "$read_body" | jq -r '.ok // false' 2>/dev/null)
  read_len=$(printf '%s' "$read_body" | jq -r '.value // ""' 2>/dev/null | awk '{print length($0)}')
  if [ "$read_ok" = "true" ] && [ "${read_len:-0}" -gt 20 ]; then
    ok "$CREDENTIAL_ALIAS" "readable (${read_len} chars, value not printed)"
  else
    bad "$CREDENTIAL_ALIAS" "not readable: $(printf '%s' "$read_body" | jq -rc '.' 2>/dev/null | head -c 120)"
  fi

  bots=$(curl -sS --max-time 20 "${auth[@]}" "$WORKER/api/bots" 2>/dev/null || true)
  if [ "$(printf '%s' "$bots" | jq -r '.ok // false' 2>/dev/null)" = "true" ]; then
    ok bot-tokens "$(printf '%s' "$bots" | jq -rc '[.bots[] | "\(.botId)=@\(.username)"] | join(" ")' 2>/dev/null)"
  else
    bad bot-tokens "$(printf '%s' "$bots" | jq -rc '.' 2>/dev/null | head -c 160)"
  fi
fi

echo "== the other owner"
# TelePost must have nothing in flight: its own review rows are what would be orphaned
# the moment its webhook stops receiving updates.
if command -v flyctl >/dev/null 2>&1; then
  if [ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$FLY_APP.fly.dev/ready" 2>/dev/null)" = "200" ]; then
    ok fly "Fly /ready 200 (rollback target alive)"
  else
    bad fly "Fly is not answering /ready; a rollback target must exist before cutting over"
  fi
  # One python call per bot's DB, with the quoting escaped for the remote shell: a
  # half-quoted query here reports "no reviews" instead of failing, which is the one
  # thing this gate must never do.
  pending=$(flyctl ssh console -a "$FLY_APP" -C "python3 -c \"import sqlite3,glob;print(sum(sqlite3.connect(p).execute('select count(*) from pending_reviews where status in (\\\"preparing\\\",\\\"pending\\\",\\\"publishing\\\",\\\"failed\\\")').fetchone()[0] for p in glob.glob('/app/data/bot*/submissions.db')))\"" 2>/dev/null | grep -E '^[0-9]+$' | tail -1)
  if [ -n "${pending:-}" ]; then
    if [ "$pending" = "0" ]; then
      ok telepost "0 open TelePost reviews"
    else
      bad telepost "$pending TelePost review(s) still open; decide them before moving the webhook"
    fi
  else
    bad telepost "could not read TelePost's review tables"
  fi
fi

echo "== webhook ownership (Telegram allows exactly one per bot)"
found=0
for var in $(env | grep -oE '^TELEGRAM_[A-Z0-9]+_TOKEN' | sort); do
  bot=$(printf '%s' "$var" | sed -E 's/^TELEGRAM_(.*)_TOKEN$/\1/' | tr '[:upper:]' '[:lower:]')
  token=${!var}
  [ -n "$token" ] || continue
  found=$((found + 1))
  info=$(curl -sS --max-time 15 "https://api.telegram.org/bot${token}/getWebhookInfo" 2>/dev/null || true)
  url=$(printf '%s' "$info" | jq -r '.result.url // empty' 2>/dev/null)
  case "$EXPECT_OWNER:$url" in
    telepost:"$TELEPOST_WEBHOOK_BASE/$bot") ok "$bot" "TelePost owns it" ;;
    worker:"$WORKER/telegram/webhook/$bot") ok "$bot" "worker owns it" ;;
    *:) bad "$bot" "no webhook registered" ;;
    *)  bad "$bot" "expected $EXPECT_OWNER to own it, found '${url:-none}'" ;;
  esac
  pending_updates=$(printf '%s' "$info" | jq -r '.result.pending_update_count // 0' 2>/dev/null)
  [ "$pending_updates" = "0" ] || note "$bot backlog" "$pending_updates pending update(s)"
  err=$(printf '%s' "$info" | jq -r '.result.last_error_message // empty' 2>/dev/null)
  [ -z "$err" ] || note "$bot last error" "$err"
done
[ "$found" = "0" ] && bad bots "no TELEGRAM_<ID>_TOKEN in the environment (or pass --from-fly)"

echo "== rollback material"
note rollback-target "$TELEPOST_WEBHOOK_BASE/<bot>  (setWebhook back to this restores TelePost)"
note rollback-note "Fly stays running and untouched until step 9; nothing else has to be restored"

echo
if [ "$failures" = "0" ]; then
  echo "preflight OK: EXPECT_OWNER=$EXPECT_OWNER holds. Safe to proceed."
  exit 0
fi
echo "preflight FAILED: $failures gate(s). Do not move any webhook."
exit 1
