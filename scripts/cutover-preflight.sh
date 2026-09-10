#!/usr/bin/env bash
#
# Cutover preflight / post-rollback check for the serverless control plane.
#
# Answers one question: is it currently safe to cut a bot's webhook over to the
# Worker, and after a rollback has it really gone back?
#
# It is READ-ONLY. It never calls setWebhook. The webhook move itself stays a
# deliberate, single, reversible command (see docs/SERVERLESS-CUTOVER.md §5-§6),
# because Telegram allows exactly one webhook per bot: pointing it at the Worker
# while TelePost is still the review owner silently stops the live review flow.
#
# Usage:
#   scripts/cutover-preflight.sh                 # check the current ownership
#   EXPECT_OWNER=telepost scripts/cutover-preflight.sh   # before cutover (default)
#   EXPECT_OWNER=worker   scripts/cutover-preflight.sh   # after cutover / after rollback check
#
# Bot tokens are read from the environment, never from disk:
#   TELEGRAM_BOT1_TOKEN, TELEGRAM_BOT2_TOKEN, ... (any TELEGRAM_<ID>_TOKEN)
# If the Fly machine is reachable, `--from-fly` reads them off it instead.
#
# Exit code 0 = every expectation holds. Non-zero = a specific check failed; the
# failing line says which.

set -uo pipefail

WORKER=${WORKER:-https://pixivflow-control-plane.redtidev1918.workers.dev}
EXPECT_OWNER=${EXPECT_OWNER:-telepost}
TELEPOST_WEBHOOK_BASE=${TELEPOST_WEBHOOK_BASE:-https://telesubmit-multi-bot.fly.dev/webhook}
FLY_APP=${FLY_APP:-telesubmit-multi-bot}

failures=0
note() { printf '  %-22s %s\n' "$1" "$2"; }
ok()   { printf '  \033[32mok\033[0m   %-17s %s\n' "$1" "$2"; }
bad()  { printf '  \033[31mFAIL\033[0m %-17s %s\n' "$1" "$2"; failures=$((failures + 1)); }

command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 2; }

echo "== control plane"
health=$(curl -sS --max-time 15 "$WORKER/health" 2>/dev/null || true)
if [ "$(printf '%s' "$health" | jq -r '.status // empty' 2>/dev/null)" = "ok" ]; then
  ok health "$WORKER"
else
  bad health "no healthy /health from $WORKER"
fi

status=$(curl -sS --max-time 15 "$WORKER/api/status" 2>/dev/null || true)
if [ -z "$status" ] || [ "$(printf '%s' "$status" | jq -r '.now // empty' 2>/dev/null)" = "" ]; then
  bad status "/api/status did not answer with JSON"
else
  mode=$(printf '%s' "$status" | jq -r '.executionMode')
  note executionMode "$mode"
  if [ "$mode" = "shadow" ]; then
    ok mode "shadow: runners publish nothing"
  else
    bad mode "expected shadow until the cutover is verified, got '$mode'"
  fi
fi

# The cron is the only clock. A stalled sweep means occurrences simply do not
# appear, which is the failure this whole architecture exists to remove.
clock=$(printf '%s' "$status" | jq -r '.clock.state // "unknown"' 2>/dev/null)
age=$(printf '%s' "$status" | jq -r '.clock.ageMinutes // "?"' 2>/dev/null)
case "$clock" in
  ok)      ok clock "last sweep ${age}m ago" ;;
  unknown) ok clock "no sweep recorded yet (a fresh deploy has not proved its cron)" ;;
  *)       bad clock "last sweep ${age}m ago -> $clock" ;;
esac

# An uncertain review means a copy may or may not have reached the channel. It is
# a human's job; it must not be silently carried across a cutover.
uncertain=$(printf '%s' "$status" | jq -r '.reviewsByStatus.uncertain // 0' 2>/dev/null)
if [ "$uncertain" = "0" ]; then
  ok reviews "0 uncertain"
else
  bad reviews "$uncertain uncertain review(s) need a human before cutover"
  # Name them: the operator has to judge each one against the channel, so a count
  # alone is not actionable.
  curl -sS --max-time 15 "$WORKER/api/status" 2>/dev/null \
    | jq -r '.recentReconciliations, .pendingReviews' >/dev/null 2>&1 || true
  for id in $(curl -sS --max-time 15 "$WORKER/control/reviews?status=uncertain" 2>/dev/null \
      | jq -r '.[]?.id // empty' 2>/dev/null); do note "uncertain" "$id"; done
fi
note reviews "$(printf '%s' "$status" | jq -rc '.reviewsByStatus // {}')"

# Provider configuration is what makes a dispatch possible at all.
if printf '%s' "$status" | jq -e '.providerConfigured == true' >/dev/null 2>&1; then
  ok provider "GitHub dispatch configured"
else
  bad provider "no GitHub dispatch token/repo configured"
fi

echo "== webhook ownership (Telegram allows exactly one per bot)"
if [ "${1:-}" = "--from-fly" ]; then
  eval "$(flyctl ssh console -a "$FLY_APP" -C 'env' 2>/dev/null \
    | grep -E '^(BOT[0-9]+_TOKEN)=' | sed 's/^/export TELEGRAM_/')" || true
fi

found=0
for var in $(env | grep -oE '^TELEGRAM_[A-Z0-9]+_TOKEN' | sort); do
  bot=$(printf '%s' "$var" | sed -E 's/^TELEGRAM_(.*)_TOKEN$/\1/' | tr '[:upper:]' '[:lower:]')
  token=${!var}
  [ -n "$token" ] || continue
  found=$((found + 1))
  info=$(curl -sS --max-time 15 "https://api.telegram.org/bot${token}/getWebhookInfo" 2>/dev/null || true)
  url=$(printf '%s' "$info" | jq -r '.result.url // empty' 2>/dev/null)
  case "$EXPECT_OWNER:$url" in
    telepost:"$TELEPOST_WEBHOOK_BASE/$bot")
      ok "$bot" "TelePost owns it ($url)" ;;
    worker:"$WORKER/telegram/webhook/$bot")
      ok "$bot" "worker owns it ($url)" ;;
    *::*|*:)
      bad "$bot" "no webhook registered" ;;
    *)
      bad "$bot" "expected $EXPECT_OWNER to own it, found '${url:-none}'" ;;
  esac
  pending=$(printf '%s' "$info" | jq -r '.result.pending_update_count // 0' 2>/dev/null)
  [ "$pending" = "0" ] || note "$bot backlog" "$pending pending update(s)"
  err=$(printf '%s' "$info" | jq -r '.result.last_error_message // empty' 2>/dev/null)
  [ -z "$err" ] || note "$bot last error" "$err"
done

if [ "$found" = "0" ]; then
  bad bots "no TELEGRAM_<ID>_TOKEN in the environment (or pass --from-fly)"
fi

echo
if [ "$failures" = "0" ]; then
  echo "preflight OK: EXPECT_OWNER=$EXPECT_OWNER holds."
  exit 0
fi
echo "preflight FAILED: $failures check(s). Do not change the webhook until these are resolved."
exit 1
