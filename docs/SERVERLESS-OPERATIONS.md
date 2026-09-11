# Serverless control plane — operations

Everything here is configuration as code: the schedules, the admission limits, the
credential identities and the execution contract live in this repository, and the
runbooks are the commands in this file.

Companions: `SERVERLESS-ARCHITECTURE.md` (design), `SERVERLESS-CUTOVER.md` (cutover,
rollback, the acceptance evidence).

---

## 1. What is deployed

| piece | where | identified by |
| --- | --- | --- |
| control plane | Cloudflare Worker `pixivflow-control-plane` | `https://pixivflow-control-plane.redtidev1918.workers.dev` |
| ledger | D1 `pixivflow-control` | id `1fa00cbc-6dcc-4a89-ba8f-30cf79cc286b` (APAC) |
| clock | Worker cron | `*/10 * * * *` — see §2 |
| execution plane | GitHub Actions `pixivflow-batch.yml` | repo `redtidev1918/pixivflow-telepost-deploy` |
| execution engine | PixivFlow (pinned ref) | `PIXIVFLOW_REF` in `control-plane/wrangler.toml` |
| review surface | Telegram | the review group + the private channel |

Free tier only: Workers Free, D1 Free. No R2, no Durable Objects, no Queues, no
Containers.

## 2. Schedules are code

`control-plane/src/schedules.ts` is the single source of truth:

```ts
{ id: 'bot1-daily', botId: 'bot1', times: ['10:00', '18:00'],
  timezone: 'Asia/Shanghai', credential: 'pixiv-main', ... }
{ id: 'bot2-daily', botId: 'bot2', times: ['10:10', '18:10'],
  timezone: 'Asia/Shanghai', credential: 'pixiv-main', ... }
```

- The **only** clock is the cron trigger in `wrangler.toml`; `SWEEP_INTERVAL_MINUTES`
  must match it and a test parses the TOML to assert they still agree.
- `CREDENTIAL_ADMISSION` declares how many concurrent executions a credential allows.
  One account, one runner.
- DST correctness comes from resolving the wall clock in the schedule's own timezone,
  never from the Worker's.

Deploy a schedule change:

```bash
cd control-plane && npx wrangler deploy
```

## 3. Deploying and migrating

```bash
cd control-plane
npx vitest run                 # unit + fault-injection suite
npx tsc --noEmit
npx wrangler d1 migrations list pixivflow-control --remote      # what is pending
npx wrangler d1 migrations apply pixivflow-control --remote     # apply
npx wrangler deploy
```

Migrations are additive and versioned. Two rules learned the hard way:

- **A rebuild must be verified against real D1**, not just the in-memory store.
  `test/schema.test.ts` parses the migrations and fails if the store selects a column
  the schema lacks — it was added after the in-memory fake happily returned a column
  D1 did not have.
- **A rename is a copy first.** The credential alias migration copied the row, the new
  alias was verified readable, every reference moved, and only then was the old row
  dropped. A copy cannot lose a credential; a half-applied rename can.

### Secrets

| secret | purpose |
| --- | --- |
| `CALLBACK_SECRET` | runner → control plane, and the ops endpoints |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram → Worker verification (fail-closed) |
| `TELEGRAM_BOT1_TOKEN` / `TELEGRAM_BOT2_TOKEN` | any `TELEGRAM_<ID>_TOKEN`; bots are discovered, not listed |
| `CREDENTIAL_MASTER_KEY` | base64 of 32 bytes; encrypts stored credentials |
| `GITHUB_DISPATCH_TOKEN` | dispatch only (temporary; a GitHub App is the end state) |

```bash
npx wrangler secret put CREDENTIAL_MASTER_KEY < /path/to/key
npx wrangler secret list
```

Losing `CREDENTIAL_MASTER_KEY` makes the stored credential undecryptable: the read
endpoint fails loudly rather than handing the runner something that cannot
authenticate. Recover by re-running `account login` (§4).

## 4. Credentials and accounts

```
credential_key = pixiv-main      stable alias, never changes
provider       = pixiv
secret         = refresh token   rotates indefinitely under the same alias
```

The alias names **which account**, never the stored field. A second account is
`pixiv-alt`, not `pixiv-refresh-token-2`.

```bash
export CONTROL_PLANE_URL=https://pixivflow-control-plane.redtidev1918.workers.dev
export CONTROL_PLANE_TOKEN=...        # prefer the env var; a flag leaks into ps

pixivflow account login  pixiv-main   # browser HERE, then push the token over HTTPS
pixivflow account rotate pixiv-main   # same flow; the alias does not change
pixivflow account list
pixivflow account status pixiv-main
pixivflow account remove pixiv-alt
```

Why the browser runs locally: there is no resident process to drive one, and the
Worker must never try. The token travels over HTTPS and is live for the next
disposable runner — no GitHub secret edit, no Worker redeploy, no image rebuild.

**Rotation is durable before success.** A runner that receives a rotated token writes
it to the control plane *before* it reports its result; if the write fails, it does
not report, so the execution stays non-terminal and cannot be mistaken for a
completed success. The value is masked and never printed.

Endpoints (all bearer-authenticated, all fail closed):

| method | path | returns |
| --- | --- | --- |
| PUT | `/control/credentials/:key` | stores; refuses empty/short/placeholder values; records `previous_hash` + `rotations` |
| GET | `/control/credentials/:key` | metadata only — never the value |
| POST | `/control/credentials/:key/read` | the value; a POST so it cannot be cached or land in a URL |
| GET | `/control/credentials` | the aliases and their metadata |
| DELETE | `/control/credentials/:key` | retires an alias |

## 5. The execution plane

`workflow_dispatch` only. The control plane sends `slot_id`, `schedule_id`, `bot_id`,
`occurrence_at`, `attempt`, `targets`, `mode`, `pixivflow_ref` and `credential_key`.

```
Resolve the Pixiv credential   ← reads the alias from the control plane
Claim the execution            ← best effort; (slot_id, attempt) is the real arbiter
Build PixivFlow
Fetch durable duplicate history ← the only layer that survives a destroyed runner
Execute the slot               ← --mode shadow publishes nothing
Persist a rotated credential    ← BEFORE reporting; failure means "do not report"
Report the result              ← items + result; write-once
Fail the job when the batch did not succeed
```

- `timeout-minutes` is the hard stop. GitHub reports a job timeout as **`cancelled`**,
  not `timed_out`, and no reporting step runs — reconciliation resolves that case from
  the GitHub API.
- The exit code **is** the status: `0` success / `2` partial / `3` failed / `4`
  uncertain / `1` process error. `0` and `2` stay green.
- A rate-limited run and a broken provider produce the same exit code but need
  opposite handling, so the runner reports `errorClass` and `retryAfterMs` and the
  control plane waits `max(server Retry-After, local bounded backoff)`.
- Concurrency group is the **credential**, not the slot: a per-slot group cannot see
  two slots sharing one account.

## 6. Telegram review

The runner uploads media once and records the message ids; the edge adapter handles the
press, performs a server-side `copyMessage` and edits the keyboard. **No media passes
through the Worker.**

- `review:<reviewId>:approve|reject` — bounded and parseable; the id is never trusted
  for data.
- One bot, one webhook. The URL's bot must own the review, **and** the press must come
  from that review's own chat; both return 403.
- Publishing an approval is a `copyMessage` into `publishChatId`; the shadow phase
  points that at a private chat so the real channel is never touched.
- The review state machine is a port of TelePost's, and its proven semantics are kept:
  see `SERVERLESS-ARCHITECTURE.md` §5 for the two deliberate deviations (stale-claim
  reaping, and re-opening a review that ended unpublished).

## 7. Observability

```bash
curl -s $WORKER/api/status | jq '{clock, reviewsByStatus, countsByStatus, nextOccurrence}'
curl -s -H "authorization: Bearer $CONTROL_SECRET" $WORKER/api/bots
curl -s -H "authorization: Bearer $CONTROL_SECRET" $WORKER/control/credentials
```

- `clock.state` is the single most important field: the cron is the only clock, so a
  stalled sweep has to be visible before an occurrence silently never appears.
  `ok` / `late` / `stalled` / `unknown`, where `unknown` means no sweep has been
  recorded yet — reporting `ok` on a fresh deploy would be a lie.
- `event_log` is structured on purpose: the old system could only be debugged by
  grepping tens of thousands of free-text lines. Events include `occurrence_created`,
  `dispatch_started`, `dispatch_success`, `dispatch_failed`, `dispatch_converged`,
  `dispatch_held`, `retry_scheduled`, `github_run_started`, `github_run_finished`,
  `slot_terminal`, `review_claims_reaped`, `runner_credential_rotated`,
  `runner_credential_removed`.
- `/api/reconcile` runs **the same sweep as the cron** — a hand-triggered sweep that
  skips a step reports success while the clock would have done more.

## 8. Failure injection that exists

The suite covers, and the risky ones were also exercised against real infrastructure:

| scenario | what proves it |
| --- | --- |
| lost cron tick | an occurrence within the lookback is recreated by the next sweep |
| dispatch timeout | GitHub reports `cancelled`; reconciliation resolves it from the provider |
| lost callback | the same, from the other direction |
| job failure / timeout / cancel | exit-code contract + provider reconciliation |
| duplicate dispatch | D1 `(slot_id, attempt)`, then the workflow concurrency group |
| concurrent reconciliation | `dispatch_converged`; three concurrent sweeps each recorded |
| reruns | a strictly later attempt may correct a terminal item; an older one may not |
| callback replay | one publish, `applied:false` on the replayed report |
| approve/reject race | one winner every round, live on real D1 |
| rate limiting | bounded backoff, server `Retry-After` honoured, admission serialises |
| a retired plane competing for the credential | 2026-09-11, live: removed the wake trigger, disabled auto-start, restored webhook ownership. The exhausted occurrence was recovered through the operator primitive, not a hand-edited row |
| exhausted automatic attempts after an external fault | `POST /control/occurrences/:slotId/requeue` grants attempt N+1 without rewriting the N that failed |
| crashed publish | the stale-claim reaper: provable → `published`, otherwise `uncertain` |

## 9. Runbooks

```bash
# is it safe to cut over / did a rollback really restore things?
TELEGRAM_BOT1_TOKEN=... TELEGRAM_BOT2_TOKEN=... CONTROL_PLANE_TOKEN=... \
  scripts/cutover-preflight.sh                    # expect TelePost to own the webhooks
EXPECT_OWNER=worker scripts/cutover-preflight.sh  # after cutover or rollback
```

`SERVERLESS-CUTOVER.md` holds the ordered procedure: cutover, rollback (one
`setWebhook` per bot), the acceptance criteria, and Fly decommission.
