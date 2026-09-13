# Cloudflare (the clock plane)

> **This page is the authoritative description of using a Cloudflare Worker as an external
> clock.** Under `split-worker` it is the **SECONDARY** external clock (`control-plane/`): the
> PRIMARY is cron-job.org, firing at the occurrence, and this Worker fires at the occurrence
> +2 minutes. Both POST the same idempotent endpoint, and the only execution authority is
> PixivFlow's durable slot ledger. **It is neither the execution authority nor the only clock.**
> For clock semantics and invariants see [scheduling.md (中文)](/concepts/scheduling.md); for
> production operations see the [scheduling runbook](/operations/scheduling.md):
> **the Worker only decides when to wake; it owns no state.**

## What it does, and what it never does

`control-plane/` is a **thin** Cloudflare Worker:

```text
cron (UTC) → schedule id → one POST with a Bearer token → done
```

| Does | Never does |
| --- | --- |
| maps cron expressions to schedule ids | compute occurrences / slot identities |
| sends a POST carrying `SCHEDULER_TRIGGER_TOKEN` | convert timezones or trust a client-supplied date |
| records trigger results | write any business table, hold a database binding |

`wrangler.toml` deliberately has **no** `[[d1_databases]]`, queue, KV or service binding: anything
that needs to remember run state belongs to the executor's slot ledger. This boundary once caused an
incident in which submissions were silently discarded because "the Worker kept a second copy of the
state" (see the historical-failure section of [roles.md (中文)](/concepts/roles.md)).

## Deployment

```bash
cd control-plane
npx wrangler secret put SCHEDULER_TRIGGER_TOKEN   # same value as on the executor
npx wrangler deploy
```

Key entries of `wrangler.toml`:

```toml
[triggers]
crons = ["0 2,10 * * *", "10 2,10 * * *"]   # UTC

[vars]
PIXIVFLOW_TRIGGER_BASE_URL = "https://pixivflow-scheduler.fly.dev"
```

Cron uses **UTC**; the same strings in `src/cron-map.ts` are the keys of the schedule map, each one
being the Asia/Shanghai planned time **minus 8 hours** (10:00 / 18:00 Beijing → 02:00 / 10:00 UTC).
`deployment-contract.test.ts` fails when the two lists drift apart.

## Fit with the executor

- The POST target is `https://pixivflow-scheduler.fly.dev/internal/schedules/<id>/run`, and the Fly
  proxy `auto_start_machines = true` wakes the stopped executor machine — so a machine-management
  API token or machine id is **not** needed.
- The trigger is "accept-then-background": it answers as soon as the request is recorded, downloads
  run in the background, and a 10–40 minute job never hangs on the HTTP connection.
- The endpoint **registers POST only**: probing it with GET returns 404 instead of 401, permanently
  masking the fact that authentication works (see [scheduling.md (中文)](/concepts/scheduling.md)).

## The boundary of using Cloudflare only as a clock

In this product Cloudflare is **only one of the clock providers**, not "part of the production
architecture". It can be replaced by any `external` cron without touching the business core. Do not
move scheduling state, review state or any business data back into the Worker.

## Verification

```bash
npx wrangler tail           # watch trigger logs (no credentials in them)
npx wrangler deployments list
```

If a day has no trigger: first confirm the cron is UTC and `PIXIVFLOW_TRIGGER_BASE_URL` points at
the right executor, then confirm the secret matches the executor's `SCHEDULER_TRIGGER_TOKEN`.

## Related pages

- Scheduling contract: [scheduling.md (中文)](/concepts/scheduling.md)
- Executor lifecycle: [flyio.md](./flyio.md), [lifecycle.md (中文)](/concepts/lifecycle.md)
- Credentials: [credentials.md (中文)](/concepts/credentials.md)
