#!/usr/bin/env bash
#
# One-shot PixivFlow executor for a Fly Machine.
#
# Lifecycle (there is deliberately nothing else):
#   claim execution -> read the Pixiv credential -> execute ONE slot ->
#   persist a rotated credential -> report items + result -> exit.
#
# No scheduler, no cron, no webhook, no Telegram setWebhook, no durable business
# state: the Fly machine is a disposable job worker and the Cloudflare Worker + D1
# remain the only durable control plane. `auto_destroy` removes the machine when
# this process exits.
#
# Inputs are non-secret machine env (set by the control plane at dispatch):
#   EXECUTION_ID SLOT_ID SCHEDULE_ID ATTEMPT BOT_ID TARGETS OCCURRENCE_AT
#   MODE CREDENTIAL_KEY CALLBACK_URL CONTROL_PLANE_URL
# Secrets come from Fly app secrets:
#   CONTROL_SECRET TELEGRAM_BOT1_TOKEN TELEGRAM_BOT2_TOKEN
#   PIXIV_CLIENT_ID PIXIV_CLIENT_SECRET PIXIV_DEVICE_TOKEN
# The Pixiv refresh token itself is read from the control plane at runtime and
# never printed.

set -uo pipefail

: "${EXECUTION_ID:?}" "${SLOT_ID:?}" "${SCHEDULE_ID:?}" "${ATTEMPT:?}" "${BOT_ID:?}" "${MODE:?}" "${CREDENTIAL_KEY:?}" "${CALLBACK_URL:?}" "${CONTROL_PLANE_URL:?}"
: "${CONTROL_SECRET:?}"

WORK=/tmp/work
mkdir -p "$WORK"
cd /app/pixivflow || exit 1

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
EXEC_PATH=$(python3 -c 'import urllib.parse,os;print(urllib.parse.quote(os.environ["EXECUTION_ID"], safe=""))')

# --- 1. Claim the execution (provider_run_id = this machine) ---------------------
claim_code=000
for attempt in 1 2 3; do
  claim_code=$(curl -sS -o /tmp/claim.json -w '%{http_code}' --max-time 30 \
    -X POST "$CALLBACK_URL/executions/$EXEC_PATH/claim" \
    -H "Authorization: Bearer $CONTROL_SECRET" -H 'Content-Type: application/json' \
    -d "{\"provider_run_id\":\"${FLY_MACHINE_ID:-unknown}\"}" 2>/dev/null || echo 000)
  log "claim attempt $attempt -> HTTP $claim_code"
  [ "$claim_code" = "200" ] && break
  sleep 5
done
if [ "$claim_code" != "200" ]; then
  log "WARN claim failed; reconciliation will adopt this machine via its metadata"
fi

# --- 2. Fetch durable duplicate history (best effort) ---------------------------
history_code=$(curl -sS -o "$WORK/processed-works.json" -w '%{http_code}' --max-time 30 \
  "$CALLBACK_URL/processed-works?bot_id=${BOT_ID}&limit=1000" \
  -H "Authorization: Bearer $CONTROL_SECRET" 2>/dev/null || echo 000)
log "processed-works -> HTTP $history_code"
if [ "$history_code" != "200" ]; then
  echo '{"illustration":[],"novel":[]}' > "$WORK/processed-works.json"
  log "WARN duplicate history unavailable; continuing without it"
fi

# --- 3. Read the Pixiv credential from the control plane ------------------------
token=$(curl -sS --max-time 30 -X POST \
  "$CONTROL_PLANE_URL/credentials/${CREDENTIAL_KEY}/read" \
  -H "Authorization: Bearer $CONTROL_SECRET" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("value",""))' 2>/dev/null || true)
if [ -z "$token" ]; then
  log "ERROR: no Pixiv credential available from the control plane"
  exit 3
fi
export PIXIV_REFRESH_TOKEN="$token"

# --- 4. Execute exactly one slot -------------------------------------------------
if [ "$MODE" = "live" ]; then
  CONFIG=/app/config/pixivflow.production.json
else
  CONFIG=/app/config/pixivflow.shadow.json
fi
log "mode=$MODE executing $EXECUTION_ID"
set +e
node dist/index.js execute-slot \
  --config "$CONFIG" \
  --schedule-id "$SCHEDULE_ID" \
  --slot-id "$SLOT_ID" \
  --attempt "$ATTEMPT" \
  --mode "$MODE" \
  --result-file "$WORK/slot-result.json" \
  --exclude-work-ids "$WORK/processed-works.json" \
  --bot-id "$BOT_ID" \
  --targets "$TARGETS" \
  --occurrence-at "$OCCURRENCE_AT"
code=$?
set -u
log "execute-slot exited $code"

# --- 5. Persist a rotated credential BEFORE any success can be recorded ----------
rotated=$(PIXIV_REFRESH_TOKEN="$token" python3 - <<'PY'
import glob, json, os, pathlib

provided = os.environ.get('PIXIV_REFRESH_TOKEN', '').strip()
if not provided:
    print('')
    raise SystemExit
# PixivAuth writes a rotated token to the runtime database's unified storage
# file and to the config file itself; both live under the ephemeral workdir.
candidates = [pathlib.Path('/app/config/pixivflow.production.json')]
candidates += [pathlib.Path(p) for p in glob.glob('/app/data/**/.pixiv-refresh-token*', recursive=True)]
candidates += [pathlib.Path(p) for p in glob.glob('/tmp/work/**/.pixiv-refresh-token*', recursive=True)]
found = ''
for path in candidates:
    if not path.exists():
        continue
    try:
        if path.suffix == '.json':
            value = json.loads(path.read_text()).get('pixiv', {}).get('refreshToken', '')
        else:
            value = path.read_text().strip()
    except Exception:
        continue
    if value and not (value.startswith('${') and value.endswith('}')) and value != provided:
        found = value
        break
print(found)
PY
)
if [ -n "$rotated" ]; then
  log "WARNING: a rotated refresh token was received; persisting it before reporting the result"
  ROTATED_TOKEN="$rotated" python3 -c "import json,os;print(json.dumps({'value': os.environ['ROTATED_TOKEN']}))" > /tmp/rotated.body
  persisted=0
  for attempt in 1 2 3 4 5; do
    persist_code=$(curl -sS -o /tmp/rotated.response -w '%{http_code}' --max-time 20 \
      -X PUT -H "authorization: Bearer $CONTROL_SECRET" -H 'content-type: application/json' \
      --data-binary @/tmp/rotated.body \
      "$CONTROL_PLANE_URL/credentials/${CREDENTIAL_KEY}" 2>/dev/null || echo 000)
    log "credential persist attempt $attempt -> HTTP $persist_code"
    if [ "$persist_code" = "200" ]; then
      persisted=1
      break
    fi
    sleep $((attempt * 5))
  done
  rm -f /tmp/rotated.body /tmp/rotated.response
  if [ "$persisted" != "1" ]; then
    log "ERROR: a rotated refresh token could NOT be stored durably; refusing to report success"
    exit 1
  fi
fi

# --- 6. Report items + result ------------------------------------------------------
python3 - "$WORK/slot-result.json" "$code" > "$WORK/result.json" <<'PY'
import json, sys

path, exit_code = sys.argv[1], sys.argv[2]
try:
    data = json.load(open(path))
except Exception:
    data = {}
status_map = {0: 'success', 2: 'partial', 3: 'failed', 4: 'uncertain'}
item_map = {'submitted': 'submitted', 'stored': 'downloaded', 'delivery_pending': 'delivery_pending',
            'no_candidate': 'no_candidate', 'duplicate': 'duplicate', 'failed': 'failed', 'missing': 'failed'}
status = status_map.get(int(exit_code) if str(exit_code).strip().isdigit() else 1, 'failed')
items = [
    {'target_id': t.get('targetId'), 'status': item_map.get(t.get('status', 'missing'), 'failed'),
     'work_id': t.get('workId'), 'error': t.get('error'), 'error_class': t.get('status')}
    for t in data.get('targets', []) if t.get('targetId')
]
print(json.dumps({
    'status': status,
    'result': json.dumps(data),
    'items': items,
    'error': data.get('error') or (None if status == 'success' else f'exit code {exit_code}'),
    'error_class': data.get('errorClass'),
    'retry_after_ms': data.get('retryAfterMs'),
}))
PY

items_code=000
for attempt in 1 2 3; do
  items_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 -X POST \
    "$CALLBACK_URL/executions/$EXEC_PATH/items" \
    -H "Authorization: Bearer $CONTROL_SECRET" -H 'Content-Type: application/json' \
    --data "$(python3 -c "import json;print(json.dumps({'items': json.load(open('$WORK/result.json'))['items']}))")" 2>/dev/null || echo 000)
  log "items report attempt $attempt -> HTTP $items_code"
  [ "$items_code" = "200" ] && break
  sleep 5
done

result_code=000
for attempt in 1 2 3; do
  result_code=$(curl -sS -o /tmp/result-response.json -w '%{http_code}' --max-time 60 \
    -X POST "$CALLBACK_URL/executions/$EXEC_PATH/result" \
    -H "Authorization: Bearer $CONTROL_SECRET" -H 'Content-Type: application/json' \
    --data @"$WORK/result.json" 2>/dev/null || echo 000)
  log "result report attempt $attempt -> HTTP $result_code"
  [ "$result_code" = "200" ] && break
  sleep 5
done
if [ "$result_code" != "200" ]; then
  # The control plane never learned the outcome; reconciliation would have to
  # infer it from provider state, which stays conservative (failed).
  log "ERROR: result report failed after 3 attempts; reconciliation will treat this run as failed"
fi

# --- 7. Exit with the batch's own exit-code contract ------------------------------
# 0/2 are legitimate business outcomes (the per-target detail is in the ledger);
# anything else is a failure the control plane has already been told about.
case "$code" in
  0|2) exit 0 ;;
  *) exit 1 ;;
esac
