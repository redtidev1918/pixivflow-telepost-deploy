# Fly.io (split-worker, the recommended production topology)

> **This page is the authoritative how-to for deploying `split-worker` on Fly.io.** It is the
> topology **current production** uses and the **recommended** Fly production topology — but
> **not the only legal production topology**. For single-machine Fly see
> [single-machine-worker-sleep.md](../architectures/single-machine-worker-sleep.md); invariants in
> [lifecycle.md (中文)](/concepts/lifecycle.md) and
> [credentials.md (中文)](/concepts/credentials.md).

## Who it is for

People who want the executor to **cost nothing to compute while idle**, good fault isolation and a
clean host credential isolation, and accept more components plus the need for an external wake-up clock.

## Topology

```text
Cloudflare Cron (thin Worker, no database)
      │  POST /internal/schedules/<id>/run  (Bearer SCHEDULER_TRIGGER_TOKEN)
      ▼
Fly Proxy  auto_start_machines = true ──► wakes the stopped executor machine
      │
      ▼
pixivflow-scheduler (own machine + own volume, normally stopped, exit(0) when done)
      │  POST /api/botN/v1/submissions   (Flycast private network + bearer)
      ▼
telesubmit-multi-bot (resident machine + own volume, the only holder of the Telegram token)
      │
      ▼
Telegram (review group → human approval → channel)
```

Matrix record: `presets.split-worker` has `telepost.lifecycle = always-on`,
`pixivflow.lifecycle = wake-run-exit`, `clock.allowed = [cloudflare, external]`,
`transport = flycast`, `stateLayout = own-volume`, `status = stable`.

## Two Fly configs, one app each

| File | App | Lifecycle | Volume |
| --- | --- | --- | --- |
| `fly/deploy.telepost.toml` | service side | `always-on` (`auto_stop=false`, `min=1`, long-running `/health` check) | `data` → `/app/data` |
| `fly/deploy.pixivflow.toml` | executor | `wake-run-exit` (`auto_start=true`, `auto_stop=false`, `restart=never`, **no** checks) | `pixivflow_data` → `/app/data` |

On first use, change `app` in both configs to your own names, then:

```bash
fly deploy -c fly/deploy.telepost.toml  --ha=false
fly deploy -c fly/deploy.pixivflow.toml --ha=false
```

## Three lifecycle rules you must read before deploying

The executor's lifecycle is decided by **three** things together, and all three are required (header
comment of `fly/deploy.pixivflow.toml`):

1. **Stopped by default**: an idle worker must not be billed or hold memory.
2. **Woken by the clock**: the Cloudflare Worker POSTs a token-bearing trigger, and the Fly proxy
   starts the stopped machine before forwarding (`auto_start_machines = true`). The trigger path
   therefore contains **no** machine-management API token and no machine id.
3. **Exits by itself when the ledger is empty**: `schedulerRuntime.exitWhenIdle` makes the process
   `exit(0)` when there is no pending/running slot and no unfinished delivery.
   `restart.policy = "never"` is the other half: let the platform restart it and the machine comes
   straight back, so the "stopped" state is never reached. `never` is the fly.toml spelling; the
   Machines API normalizes it to `restart.policy = "no"`, and flyctl rejects `no` in a toml.

**The executor deliberately has no `http_service.checks`** (`SI-5`): a probe would keep hitting a
machine that just decided to finish, and wake it again and again. There is no health check and no
platform auto-stop (`auto_stop=false`) — the stop decision belongs to the executor's own ledger.

## Image pinning

| App | How it is pinned | Rule |
| --- | --- | --- |
| Service side | `TELEPOST_IMAGE` (a release version, e.g. `...telepost:2.17.5`) | **never `latest`** |
| Executor | `PIXIVFLOW_REF` (**40-character commit sha**) | never a branch name, never a tag |

`PIXIVFLOW_REF` must be a 40-character commit sha: the image echoes the build-arg literal at
runtime (`PIXIVFLOW_REVISION=${PIXIVFLOW_VERSION}+${PIXIVFLOW_REF}`), so pinning a tag makes
"which commit is running" unanswerable. `scripts/verify-images.sh` rejects a non-commit
`PIXIVFLOW_REF` outright. Changing `PIXIVFLOW_REF` deploys an unreleased commit to the executor
(`docker/pixivflow-scheduler.Dockerfile` clones and builds that commit).

Path rules (`fly/deploy.pixivflow.toml`): `PIXIV_DOWNLOADER_CONFIG` is an **absolute** path to the
runtime copy on the volume (`/app/data/production.json`; hydrated from the image default on first
start, `watchConfig=true`); `storage` paths inside the config use **relative** paths
(`./pixivflow.db`, `./downloads`) and resolve back into the same volume. PixivFlow's loader
"auto-corrects" absolute paths outside the config directory by substituting the default
`/app/downloads` (a **temporary** path next to the volume).

## Secrets

```bash
# executor: Pixiv credentials + trigger token + submit token (no Telegram token at all, SI-1)
fly secrets set -a pixivflow-scheduler \
  PIXIV_REFRESH_TOKEN=... SCHEDULER_TRIGGER_TOKEN=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=...

# service side: Telegram tokens + submit token (the executor authenticates with it)
fly secrets set -a telesubmit-multi-bot \
  BOT1_TOKEN=... BOT1_CHANNEL_ID=... BOT1_OWNER_ID=... \
  TELEPOST_BOT1_SUBMIT_TOKEN=...
```

A Fly secret is invisible (`inactive`) while the machine is stopped, which is normal — the wake-up
does not use a secret, it uses a token-bearing trigger request.

## Two hard transport constraints

1. **The service side's `force_https = false` must not be removed**: if the plaintext Flycast
   delivery (WireGuard-protected 6PN) gets 301-redirected to HTTPS by the Fly proxy, the executor
   does not follow that path and delivery dead-ends. Toward the public internet, the Telegram
   webhook and review API still go over HTTPS.
2. **The executor's `TELEPOST_API_BASE_URL = http://telesubmit-multi-bot.flycast`**: this is the
   only way the executor can reach the service side, and it carries **no** Telegram token and no
   channel id (`SI-1`).

## Clock

The thin Worker in `control-plane/` is the production primary clock: cron (UTC) → schedule id → one
token-bearing POST, with no D1/queue/KV binding. Deployment and secrets: [cloudflare.md](./cloudflare.md).
Any `external` cron works as well (see [scheduling.md (中文)](/concepts/scheduling.md)).

## Verification

```bash
./scripts/verify-images.sh        # live images == pinned commit/version
./scripts/verify-webhooks.sh      # TelePost is the only webhook owner (SI-2)
fly status -a telesubmit-multi-bot
fly status -a pixivflow-scheduler  # stopped while idle: a healthy state, not a failure
```

## Cost model

The saving comes from the **executor being stopped by default**, not from the service side sleeping
(the service side must stay resident; a cold start is visible to users). See
[lifecycle.md (中文)](/concepts/lifecycle.md) and the "process sleep ≠ machine sleep"
explanation in [single-machine-worker-sleep.md](../architectures/single-machine-worker-sleep.md).

## Related pages

- Preset description: [split-worker.md](../architectures/split-worker.md)
- Lifecycle invariants: [lifecycle.md (中文)](/concepts/lifecycle.md)
- Credential boundary: [credentials.md (中文)](/concepts/credentials.md)
- Clock plane: [cloudflare.md](./cloudflare.md)
- Migration: [migration.md (中文)](/architectures/migration.md)
