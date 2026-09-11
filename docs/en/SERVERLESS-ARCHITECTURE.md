# Serverless control plane — architecture

> This is the **production shape** of `pixivflow-telepost-deploy`. The Fly + TelePost
> daemon path in the older docs is kept only as the rollback target until the cutover
> is verified.

## 1. Why this exists

The previous architecture failed in ways that retrying could not fix, because the
failures were structural. Each row below is a class of failure that is now impossible
**by construction**, not better-handled:

| old failure mode | why it cannot happen now |
| --- | --- |
| machine asleep when the trigger fires | there is no machine; a Cloudflare cron + D1 reconcile |
| 600s / any HTTP relay timeout kills the run | no request carries the run |
| HTTP request lifetime == task lifetime | dispatch returns immediately; the runner is disposable |
| a scheduler daemon must stay online | there is no daemon anywhere |
| a lease left behind by a crashed worker | there is no lease |
| a timeout fires but the heartbeat keeps renewing | there is no heartbeat |
| one lost Cloudflare tick loses the day | every sweep recomputes the occurrences it should have |
| GitHub cron delayed for hours | GitHub is never the clock |
| one process or machine failure loses an occurrence | the D1 ledger plus reconciliation |
| two clocks double-post | `UNIQUE(schedule_id, occurrence_at)` + account admission |
| a 256MB always-on instance constrains everything | there is no always-on instance |

## 2. Components

```
        Cloudflare Worker + D1                    GitHub Actions                 Telegram
   ┌───────────────────────────────┐        ┌────────────────────────┐     ┌──────────────────┐
   │ cron */10  = the only clock   │        │ pixivflow-batch.yml    │     │ review group     │
   │ reconcile: create / expire /  │dispatch│  1 hard timeout        │     │  approve / reject│
   │  adopt provider / admit       │───────▶│  1 concurrency group   │     │ private channel  │
   │ D1 ledger  = the only state   │◀───────│  reports over HTTPS    │     └──────────────────┘
   │ reviews    = the decision     │ claim/ │  then destroyed        │              ▲
   │ credentials= encrypted at rest│ result └────────────────────────┘              │
   └───────────────────────────────┘                                                │
              ▲   ▲                                                                 │
              │   └── getWebhookInfo / callback_query ───────────────────────────────┘
              └──── /control/* from the runner (bearer)
```

| component | responsibility | what it must never do |
| --- | --- | --- |
| Cloudflare Worker | the clock, the ledger, admission, review decisions, publish by server-side copy | carry media, or hold state in memory |
| D1 | every durable fact: occurrences, executions, items, reviews, credentials, events | be treated as a queue that can be retried blindly |
| GitHub Actions | execute one occurrence, then vanish | be the clock, or own any state |
| Telegram | durable media and the human decision | be polled |

## 3. Identity: the canonical occurrence

`slot_id = schedule_id + canonical occurrence timestamp`, derived from the schedule's
times and timezone — **never** `Date.now()`, never the runner's start time.

```
bot1-daily          10:00, 18:00 Asia/Shanghai
bot2-daily          10:10, 18:10 Asia/Shanghai
```

Two schedules at 10:00 and 10:10 overlap, so the account, not the slot, is the
resource that has to be serialised (§6).

## 4. Exactly-once, in layers

There is no single mechanism, and there is deliberately no distributed lock.

| layer | mechanism | what it stops |
| --- | --- | --- |
| 1 | `UNIQUE(schedule_id, occurrence_at)` | a second occurrence for the same canonical time |
| 2 | `UNIQUE(slot_id, attempt)` | a second execution of the same attempt |
| 3 | account admission in the sweep | two runs against one external account |
| 4 | workflow `concurrency: pixivflow-<credential_key>` | a duplicate dispatch racing (a backstop; D1 owns the queue) |
| 5 | review claim: one conditional UPDATE | a double tap, a Telegram replay, a retried webhook |
| 6 | terminal writes guarded by `AND status='publishing'` | a late writer clobbering a resolved row |
| 7 | `IDEMPOTENT`/write-once result reporting | a replayed report overwriting a terminal result |

Every layer was exercised against real Cloudflare, real D1 and real GitHub Actions —
see `SERVERLESS-CUTOVER.md` §5 for the evidence, including the three duplicate
protection layers verified live.

## 5. The states

Execution rollup (`slot_occurrences.status`) is derived, never asserted:

```
pending ──dispatch──▶ running ──success/partial──▶ success | partial
   │                       │
   │                       ├─ failure, attempts left ──▶ pending   (with retry_not_before)
   │                       └─ failure, no attempts    ──▶ failed
   └── deadline passed ────────────────────────────────▶ expired
```

Review (`reviews.status`) is a port of TelePost's production state machine, because
those semantics were already proven and a weaker reinvention is how duplicates happen:

```
pending ──claim──▶ publishing ──confirmed copy──▶ published
   │                   │
   │                   ├─ definitive rejection ──▶ failed   (re-claimable; the button
   │                   │                                    becomes "retry publish")
   │                   └─ ambiguous ─────────────▶ uncertain (terminal, needs a human)
   └── TTL ──▶ expired          + rejected
```

`uncertain` is this deployment's addition: a publish whose outcome Telegram did not
confirm is a human's problem, never an automatic retry. The stale-claim reaper
resolves a claim that recorded a message id as `published`, and sends anything else to
`uncertain` — TelePost's own audit shows its reclaim-then-resend path can post the same
media twice.

## 6. The shared external resource

The Pixiv account is rate-limited **per account**, so single-slot idempotency is not
enough: two different schedules sharing one credential must not run together.

A schedule declares `credential: pixiv-main`, and the control plane treats that as a
**credential execution lock**: at most `maxConcurrentExecutions` occurrences may hold
it, across *all* schedules, because the limit belongs to the account and not to a slot.

```
                    D1  (the only admission authority)
                     │
        ┌────────────┴────────────┐
   occurrence queue          execution state
                     │
              credential admission
                     │
                 pixiv-main            maxConcurrentExecutions = 1
                     │
            one active execution
```

Responsibilities, in layers:

| Layer | Role |
| --- | --- |
| D1 credential admission | **the lock authority.** The queue and the lock are the same decision, taken before a runner exists |
| GitHub `concurrency: pixivflow-<credential_key>` | a second line of defence if D1 ever dispatches twice; never the queue |
| PixivFlow process | the worker. It asserts nothing about ownership |

**The lock is derived, not stored.** There is no `locked=true` row, no lease to renew
and no fencing token. A credential is held while an execution consuming it is in
`dispatching`/`dispatched`/`running`; it is released the moment that execution reaches
a terminal status. That removes the failure mode where the execution says terminal and
a separate lock row still says locked.

**Acquisition is atomic.** The credential rides on the execution row and the guard is
part of the `INSERT` that opens it:

```sql
INSERT ... WHERE ? IS NULL
  OR (SELECT COUNT(*) FROM executions
       WHERE credential_key = ? AND status IN ('dispatching','dispatched','running')) < ?
```

A read followed by a separate write would let two reconcilers both observe a free
credential and both dispatch different occurrences — from a single control plane. A
losing sweep reports the occurrence as `held` with
`{"reason":"credential_busy"}`, and it stays `pending` in D1; nothing is parked in a
GitHub pending queue where visibility is poor and reconciliation is guesswork.

**A lost runner cannot deadlock the account.** Admission is evaluated *after* provider
reconciliation, so an execution whose run has finished is already terminal and its
credential is already released. Release never depends on the runner reporting.
`CREDENTIAL_HOLD_MAX_MS` bounds the pathological case.

**No lease, and no fencing token, on purpose.** One control plane, one provider whose
run state is authoritative, and a per-attempt execution id already ordered by
`attempt` — the existing terminal-write guard and the "a strictly later attempt may
supersede a terminal item, an older one may not" rule carry the fencing the current
architecture needs. A lease subsystem earns its complexity only with self-hosted
runners, multiple providers, or genuinely unqueryable executors. See
`docs/SERVERLESS-CUTOVER.md` §8.2 for the incident that made the lock non-negotiable.

Rate limiting is a **separate** mechanism and stays: the lock stops the control plane
from contending with itself, while `pixiv_rate_limit`, `Retry-After`,
`retry_not_before` and bounded backoff handle Pixiv limiting us. Raising the watchdog
from 30 minutes would treat neither.

The same identity keys the GitHub concurrency group, so the backstop cannot disagree
with the queue it backs up.

Found the hard way, in shadow validation: four occurrences dispatched at once put the
account into rate-limit cooldown, two slots burned their whole run budget waiting, and
the retry then finished in 6 minutes. Serial, the same four run in 3.0–4.3 minutes with
zero 429s.

**Invariant: one credential has exactly one execution plane owner at any moment.**

Admission inside the control plane is not enough on its own, because a retired plane
can still be holding the same account. Found the hard way on 2026-09-11: a leftover
GitHub watchdog woke the stopped Fly machine, TelePost and PixivFlow came back up,
both planes spent the morning in each other's rate-limit cooldown, and every scheduled
occurrence failed 3/3 while nothing was wrong with any of them. See
`docs/SERVERLESS-CUTOVER.md` §8.1.

The corollary is what the incident taught: a plane that is not the owner must be
unable to participate — not merely stopped. It must have no wake trigger, no
auto-start, and no ability to claim the Telegram webhook on boot. Otherwise "stopped"
is a momentary state that the next inbound request undoes.

## 7. Credentials

```
credential_key = pixiv-main      stable alias, never changes
provider       = pixiv
secret         = refresh token   rotates indefinitely under the same alias
```

The alias names **which account**, never what is stored inside it. D1 holds the value
AES-GCM encrypted with a Worker secret; the API returns it only through an explicit
`POST .../read`, and never through metadata. A rotation is persisted **before** the run
may report success, so a token that rotates is never lost with the runner that saw it.
See `SERVERLESS-OPERATIONS.md` §4.

## 8. What is deliberately not here

- **No Durable Objects, no Queues, no R2, no Containers.** Workers Free + D1 Free only.
- **No heartbeat, no lease, no daemon.** Provider state is the only liveness authority.
- **No media through the Worker.** The runner uploads once; publishing is a server-side
  `copyMessage`.
- **No second Telegram backend in production.** Bots are discovered from the
  environment (`TELEGRAM_<ID>_TOKEN`), so a bot is a secret, not a code path.
