# `split-worker` — split executor (current production)

| | |
| --- | --- |
| Support level | **Stable** |
| Implementation status | Implemented, tested, **running in production** |
| Platforms | Fly.io (reference implementation); the topology itself is not bound to a platform |
| In one sentence | `executor` and `publisher` each get their own machine and volume; the `executor` is stopped by default, woken by an external clock through the platform proxy, and exits by itself once its ledger is empty. |

Machine-readable definition:
[`presets.split-worker` in `architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json).

**This is the recommended deployment topology on Fly.io, but it is not the only deployment
topology.** Alongside it there are [`single-host`](single-host.md),
[`single-machine-worker-sleep`](single-machine-worker-sleep.md) and
[`remote-worker`](remote-worker.md). How to choose:
[choose-architecture.md](../getting-started/choose-architecture.md).

---

## Who it is for

- People who care most about the Fly.io compute bill: time when no task runs costs no compute.
- People who care most about reliability: an `executor` crash or OOM does not reach the
  user-visible submission path.
- People who want the cleanest credential boundary: the executor machine holds no Telegram
  credential at all.
- People who already have several devices, or accept three components (two Fly apps + one clock).

If you have only one machine, or do not want to maintain an external clock, look at
[`single-host`](single-host.md).

---

## Topology

```text
PRIMARY    cron-job.org        fires AT the occurrence
        ─┐
         ├─► the same authenticated, idempotent POST /internal/schedules/{scheduleId}/run
SECONDARY  ─┘   Cloudflare Cron (occurrence + 2 minutes)
        │
        ▼
Fly Proxy (wakes the stopped machine automatically)
        │
        ▼
Fly App: pixivflow-scheduler        own machine + own volume, normally stopped
  executor  ── durable slot ledger = the single execution authority
        │  existing httpMultipart delivery + stable idempotency key
        ▼
Fly App: telesubmit-multi-bot        resident
  publisher + telegram-ingress
        │  after human approval
        ▼
Telegram channel
```

### Clock topology: PRIMARY / SECONDARY

Production `split-worker` runs **two independent external clocks** over **the same** schedule set:

| | Provider | Fire time (Asia/Shanghai) | Expression (UTC) |
| --- | --- | --- | --- |
| **PRIMARY** | cron-job.org | at the occurrence: `bot1-daily` 10:00, `bot2-daily` 10:10 | `bot1` `0 2 * * *`; `bot2` `10 2 * * *` |
| **SECONDARY** | Cloudflare Cron (`control-plane/`) | occurrence + 2 minutes | `bot1` `2 2 * * *`; `bot2` `12 2 * * *` |

The machine-readable sources of both declarations are `control-plane/src/cron-map.ts`
(`SECONDARY_OFFSET_MINUTES = 2`) and `control-plane/wrangler.toml`;
`control-plane/test/redundant-clock.test.ts` fails when the secondary stops being the primary plus
the documented offset.

- **There is exactly one execution authority: PixivFlow's durable slot ledger.** Neither clock
  computes an occurrence, owns state, generates a slot id, calls TelePost, or controls a Fly
  Machine. Each of them only sends one idempotent trigger.
- **Whichever arrives second converges on the slot the first one created.** Duplicate triggers are
  expected and safe: they yield the same disposition and never start a second run.
- **The `executor` lifecycle is still `wake-run-exit`**: the wake is the trigger request through the
  platform proxy, and the stop decision belongs to the executor's own ledger. That is independent of
  how many clocks exist.

> **PRIMARY / SECONDARY is an operational provider assignment, not a new deployment preset.**
> The preset set is still exactly four. **Provider != architecture**: changing the clock provider
> changes no role ownership, does not change the topology's shape, and requires no change to the
> business core. Choosing a provider is an operational decision, recorded in the
> [deployment contract](../reference/deployment-contract.md) and in `control-plane/` — never in a
> preset definition.

Why the offset is 2 minutes, why it must be positive, and why Cloudflare is not the primary:
see the [2026-09-13 missed-trigger incident (中文)](/incidents/2026-09-13-schedule-trigger-miss.md).

| Plane | Deployment unit | State it owns | It never owns |
| --- | --- | --- | --- |
| `clock` | PRIMARY `cron-job.org` + SECONDARY `control-plane/` (Worker `pixivflow-control-plane`) | cron → schedule id mapping, one trigger token | occurrence, slots, credentials, review, publication, Telegram |
| `executor` | `fly/deploy.pixivflow.toml` (app `pixivflow-scheduler`) | slot ledger, execution lease, download cache, delivery outbox, Pixiv credentials | **Telegram token, channel, review decision** |
| `publisher` + `telegram-ingress` | `fly/deploy.telepost.toml` (app `telesubmit-multi-bot`) | user sessions, submission idempotency keys, review queue, publication records, Telegram token | Pixiv login, downloads, slot scheduling |

`fly/deploy.pixivflow.toml` and `fly/deploy.telepost.toml` are the **only two sources of Fly
topology** in this repository. `control-plane/test/deployment-contract.test.ts` fails when a third
Fly configuration appears, when cron and the mapping disagree, or when volume or stop parameters
are changed. Historically it was exactly "two configurations that both looked authoritative" that
brought the mixed topology back.

---

## Resource requirements

| Unit | Fly machine | Notes |
| --- | --- | --- |
| `clock-edge` | 0 (Cloudflare Workers, SECONDARY) | within the free allowance; no database binding, no state |
| `clock-primary` | 0 (cron-job.org, PRIMARY) | a second provider in a second failure domain; configured in its console only, this repository never registers it |
| `worker-machine` | 1 × 512 MiB | runtime memory bounded by `NODE_OPTIONS=--max-old-space-size=384` and `download.concurrency=1` |
| `service-machine` | 1 × 512 MiB | two bots; `SEARCH_ENABLED=false`, `DB_CACHE_KB=1024` |

> `fly/deploy.pixivflow.toml` and `fly/deploy.telepost.toml` currently **do not declare
> `[vm] memory_mb`**, so the machine size is decided on the Fly side. The 512 MiB in the docs and
> in historical configurations is a design intent, not a hard constraint in the configuration
> file; use `fly machine list` to check the real size. Resource profiles:
> [performance.md (中文)](/operations/performance.md).

Neither volume may be shared: run `fly volumes create` separately per app, and `--ha=false` is
required (one machine is needed to mount one volume).

---

## Lifecycle

| Role | Lifecycle | Who wakes it | Who decides to stop |
| --- | --- | --- | --- |
| `clock` | `always-on` | not applicable | not applicable (stateless) |
| `executor` | `wake-run-exit` | the trigger request starts the stopped machine through Fly Proxy automatically | **the `executor`'s own ledger** (`exitWhenIdle`) |
| `publisher` | `always-on` | never sleeps | never stops |
| `telegram-ingress` | `always-on` | never sleeps | never stops |

```text
stopped (saving money, healthy idle)
   │  the clock POSTs /internal/schedules/<id>/run ─► Fly Proxy starts the machine
   │                                                ─► answers as soon as it is persisted, downloads run in the background
   │                                                ─► ledger empty → idleGraceMs → exit(0) → stopped
```

The three lifecycle decisions are spread across three places, and **all three are required**:

1. **Stopped by default**: an idle executor should not be billed and should not hold memory.
2. **Woken by the clock**: `auto_start_machines = true`, so the trigger path needs no
   machine-management API token and no machine identifier to maintain.
3. **Exits by itself**: `schedulerRuntime.exitWhenIdle = true`; `restart.policy = 'never'` is the
   other half of that decision — a machine with a restart policy comes straight back and the
   `stopped` state is never reached.

Parameters: `idleGraceMs = 900000` (10 minutes: merges adjacent schedules while draining
just-finished delivery retries), `maxLifetimeMs = 10800000` (a 3-hour backstop for abnormally long
runs).

**The `publisher` is the opposite: it never sleeps.** A cold start is visible to users
(direct-message submission looks broken), so `auto_stop_machines = false`,
`min_machines_running = 1`, and the long-standing health check stays.

### Three prohibitions

| Prohibited | Reason |
| --- | --- |
| A health check on the `executor` | A probe is itself a request. The Fly proxy would wake a machine that just decided it had finished, and `stopped` would never be reached. |
| Using platform auto-stop to stop the `executor` | The trigger side answers as soon as it persists, so in the proxy's view the connection has long been idle while downloads are still running (measured: 10–40 minutes). Inferring a stop from idleness cuts batches in half. |
| Deploying a second **PRIMARY** clock (or a second scheduler, or a second execution authority) | The trigger side is idempotent, so a **delayed duplicate trigger is harmless**; what is dangerous is a second set of schedule definitions or a second copy of execution state, because that is what contends for the same Pixiv credential on the same occurrence. A redundant external clock — PRIMARY plus a delayed SECONDARY — converges through the same durable slot and is **not** in this category. |

---

## Where state lives

| State | Location | Cost of loss |
| --- | --- | --- |
| PixivFlow slot ledger, slot item | `pixivflow_data` volume `/app/data` | Selected works and occurrence records are lost |
| Download cache, metadata | same | Must be downloaded again |
| Delivery outbox | same | Undelivered works are permanently lost |
| Pixiv credentials, rate-limit state | same (+ platform secret) | Must be re-authorised |
| TelePost per-bot SQLite | `data` volume `/app/data/bot{N}/` | Submission idempotency and the review queue are lost |
| TelePost runtime policy overrides | `data/bot{N}/runtime-policy.json` | Falls back to the `[env]` deployment defaults |

**Two volumes, one per machine.** Physical separation is strongest here. The cross-preset
invariant is **non-overlapping state namespaces (SI-7)**, not "physical volumes are never shared":
co-located presets share one physical volume with disjoint subdirectories.

> **Path rule (hot-reload config):** `PIXIV_DOWNLOADER_CONFIG` points at the runtime copy on the
> volume (`/app/data/production.json`; the versioned default is copied from the image on first
> start). The **storage paths inside** the configuration must stay relative (`./pixivflow.db`,
> `./downloads`) and, because the config lives in the volume root, they resolve back into the same
> volume. The loader rewrites absolute paths that fall outside the configuration directory back to
> its default `/app/downloads` — outside the volume and lost when the machine stops.

---

## Network

| Link | Transport | Must be kept |
| --- | --- | --- |
| clock → `executor` | `public-https` (Fly Proxy, `auto_start_machines=true`) | The trigger carries a bearer token; TLS terminates at the Fly proxy |
| `executor` → `publisher` | `flycast` (`http://telesubmit-multi-bot.flycast`) | **The URL carries no `:8080`**; `force_https = false` |
| Telegram → `publisher` | public HTTPS webhook | `telegram-ingress` is the only webhook owner |
| `publisher` → review group / channel | public HTTPS | Initiated by TelePost itself |
| Egress | each machine has its own egress | Egress is a replaceable execution resource that must be qualified first |

Two measured facts: do not "correct" them.

- **The Flycast delivery URL must not carry `:8080`**: Fly Proxy listens on port 80 and forwards to
  port 8080 inside the network; including the port gives ECONNRESET (commit `b95269a`).
- **`force_https = false` must not be deleted**: setting it to `true` makes Flycast private-network
  HTTP delivery get a 301 to HTTPS, which is a dead end. The public Telegram webhook and the review
  API still use HTTPS and are unaffected.

`.internal` (6PN direct, bypassing the proxy) was once used as the delivery address; its problem is
that it cannot wake a stopped machine, so it was replaced by `.flycast` in commit `8698e2b`.

---

## Strengths

- **Almost no compute cost while the downloader is not running.** The cost is dominated by the
  `executor` not running by default.
- **Good failure isolation.** An `executor` crash or OOM does not hit the Telegram path directly;
  user submissions and the review button stay available.
- **Cleanest credential boundary.** The executor machine image holds **no** Telegram token and no
  channel ID (statically guaranteed by `control-plane/test/webhook-ownership.test.ts`), so it
  cannot publish to a channel, cannot bypass review, and cannot point the submission bot's webhook
  at itself.
- **The two roles can be upgraded, scaled and rolled back independently.**
- **The `publisher` is resident**, so submissions answer immediately with no user-visible cold-start
  delay.

---

## Weaknesses

- **More components.** Two Fly apps + one Cloudflare Worker + one cron-job.org account + two volumes.
- **One more volume**: backup and recovery must cover two locations.
- **An external wake trigger is required.** Production runs two clocks in two independent failure
  domains (PRIMARY cron-job.org / SECONDARY Cloudflare), so one provider failing silently no longer
  means a missed run; if both fail, the run is still not back-filled.
- **Deployment and debugging are more complex.** "The machine is stopped" has to be understood as a
  healthy state, not a failure.
- **Deeper platform coupling.** The current two configurations are Fly-specific (Flycast, Fly Proxy
  wake semantics, the `restart.policy` naming).

---

## Failure model

| Failure | Blast radius | Symptom | Recovery |
| --- | --- | --- | --- |
| `executor` OOM / crash | Only the execution plane | The batch is interrupted, the machine may return to stopped | The slot ledger lets the next wake resume; `stopped` is not a failure |
| `executor` misconfigured with a health check or auto-stop | Only the execution plane | Batches cut in half, or the `stopped` state unreachable | Remove the check and the auto-stop |
| `publisher` crash | User-visible | Direct-message submission looks broken | `restart.policy = 'always'` restarts it automatically |
| The clock misses a trigger | That occurrence is lost | That scheduled run does not execute | **No back-fill** (`catchUpMissedRuns=false`); the next run is normal |
| One clock fires nothing, silently | The occurrence still runs | No fire record on that provider's side | **The other clock fires on the same occurrence** (+2 minutes); a missed run means neither fired, and it is then **not** back-filled (`catchUpMissedRuns=false`) |
| A second **PRIMARY** clock (or a second scheduler) comes online | The two planes contend for the same Pixiv credential | Rate limiting and escalating penalty | Take the second primary offline immediately; keep exactly one execution authority |
| Volume loss | The corresponding plane | Ledger/outbox or review queue disappears | Restore from a volume snapshot |
| Egress rate-limited by Pixiv | Only the execution plane | `rate limit cooldown`, escalating penalty | Change egress and requalify; see the [incident record (中文)](/incidents/2026-09-11-pixiv-egress-rate-limit.md) |

The failure domain is `separated`: an `executor` failure does not propagate to the `publisher`,
which is the core benefit of this preset over `single-host`.

---

## Cost model

| Item | Notes |
| --- | --- |
| `clock-edge` | A Cloudflare Worker (SECONDARY), within the free allowance |
| `clock-primary` | cron-job.org (PRIMARY), within its own tier; this repository never registers it |
| `worker-machine` | Billed only while awake; normally `stopped` |
| `service-machine` | Billed resident — that is the price of "submissions answer immediately" |
| The two volumes | Billed by capacity, independent of running state |

The saving comes from the `executor`'s `stopped` state, **not** from a process exiting.
`single-machine-worker-sleep` saves memory but not the bill; the two are not interchangeable.

---

## Deployment steps

```bash
# 1) change the app name in both configurations
#    fly/deploy.telepost.toml  → app
#    fly/deploy.pixivflow.toml → app
fly config validate -c fly/deploy.telepost.toml
fly config validate -c fly/deploy.pixivflow.toml

# 2) service side (resident)
fly volumes create data -a <your-telepost-app> --size 1 --region iad
fly deploy -c fly/deploy.telepost.toml --ha=false
fly secrets set -a <your-telepost-app> \
  BOT1_TOKEN=... BOT1_CHANNEL_ID=... BOT1_OWNER_ID=... \
  BOT2_TOKEN=... BOT2_CHANNEL_ID=... BOT2_OWNER_ID=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=...

# 3) executor side (own volume; the volume name must match mounts.source)
fly volumes create pixivflow_data -a <your-pixivflow-app> --size 1 --region iad
fly deploy -c fly/deploy.pixivflow.toml --ha=false
fly secrets set -a <your-pixivflow-app> \
  PIXIV_CLIENT_ID=... PIXIV_CLIENT_SECRET=... PIXIV_DEVICE_TOKEN=... PIXIV_REFRESH_TOKEN=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=... TELEPOST_BOT2_SUBMIT_TOKEN=... \
  SCHEDULER_TRIGGER_TOKEN=...
# no Telegram token should appear on the executor side.

# 4) clock: two independent providers over the same schedule set
#    4a) SECONDARY: Cloudflare Worker
cd control-plane && npx wrangler secret put SCHEDULER_TRIGGER_TOKEN && npx wrangler deploy

#    4b) PRIMARY: the cron-job.org console
#        This repository does not register it and does not hold its credential —
#        a separate failure domain is the whole reason two clocks exist.
#        Create two cron jobs pointing at the same endpoint as 4a,
#        with Authorization: Bearer <SCHEDULER_TRIGGER_TOKEN>
#
#          bot1-daily   0 2 * * *
#          bot2-daily  10 2 * * *
#
#        The expressions come from the `PRIMARY_CRONS` export in
#        control-plane/src/cron-map.ts, so the operator runbook and the contract
#        test read one list instead of copying it twice.
#        Deploying the two clocks is TWO separate operator steps; record each one.
```

Post-deployment checks (all read-only; they print `SKIP` when a variable is missing and never print
secrets):

```bash
./scripts/verify-production.sh     # three-plane status, stop parameters, trigger auth, webhook ownership
./scripts/verify-images.sh         # whether the deployed image/commit equals the one pinned in the repository
./scripts/smoke-pixivflow.sh       # executor stopped + unauthorised trigger rejected
./scripts/smoke-telepost.sh        # probes and submission API auth
./scripts/verify-webhooks.sh       # webhook ownership of both bots
```

Details: [flyio.md](../platforms/flyio.md) and [cloudflare.md](../platforms/cloudflare.md).

---

## Migration paths

| Source | Target | Main actions |
| --- | --- | --- |
| `single-host` | this preset | Split both roles' state into two volumes; add an external clock; confirm the delivery address becomes `.flycast` with no port |
| `single-machine-worker-sleep` | this preset | Replace on-demand spawning with an own machine + external trigger; split both roles from one volume into two |
| `remote-worker` | this preset | Keep the "two roles, two machines, two volumes" shape while changing platform; reconfigure the private-network transport |

Reverse migration holds as well. The data that must move, and the files that must not, are in
[migration.md (中文)](/architectures/migration.md).

---

## Boundary comparison with the other presets

| | `single-host` | `single-machine-worker-sleep` | `split-worker` | `remote-worker` |
| --- | --- | --- | --- | --- |
| Machines | 1 | 1 | 2 | 2 (may span platforms) |
| Can the `executor` stop | No (resident container) | Yes (process) | Yes (machine) | Platform-dependent |
| Saves memory | No | **Yes** | Partly | Partly |
| Saves the compute bill | No | **No** | **Yes** | Yes |
| Host credential isolation (`hostCredentialIsolation`) | No | No | **Yes** | **Yes** |
| Executor holds Telegram credentials (SI-1) | **No** | **No** | **No** | **No** |
| Needs an external clock | No | Optional | Required, and production runs two (PRIMARY `cron-job.org` + SECONDARY `cloudflare`; `external` is a provider value) | Optional |
