# `single-host` — single host, all roles together

| | |
| --- | --- |
| Support level | **Stable** |
| Implementation status | Implemented (`docker-compose.yml`, `docker/combined.Dockerfile`), CI-covered, not production-proven |
| Platforms | Docker Compose, systemd |
| In one sentence | One machine runs every role: TelePost and PixivFlow as separate containers, sharing one `./data` directory, communicating over the container network. |

Machine-readable definition:
[`presets.single-host` in `architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json).

---

## Who it is for

- People with one home machine, VPS, NAS or lightweight server.
- People who do not want to understand a distributed architecture and want one command to run it.
- People willing to accept "both roles share one failure domain" in exchange for the fewest
  components.
- People already running under Docker Compose who will not split machines any time soon.

If you have only one 512 MiB machine and want to cut the Fly bill, this preset is not the answer:
see [`single-machine-worker-sleep`](single-machine-worker-sleep.md) and
[`split-worker`](split-worker.md).

---

## Topology

```text
One Host
│
├─ telepost container    publisher + telegram-ingress   resident
├─ pixivflow container   executor + clock(internal)     resident
└─ ./data volume         state                          per-role subdirectories
        ├─ bot1/          per-bot SQLite, runtime-policy.json
        ├─ bot2/
        └─ pixivflow/     pixivflow.db, download cache, outbox
```

Optional units:

```text
caddy container    --profile webhook   public HTTPS ingress (webhook mode)
proxy container    --profile proxy     bundled Mihomo (mainland-China network)
```

The comments in `docker-compose.yml` are blunt about it: the default is "one combined host", with
both services on the same Docker host. To split into two hosts, put the pixivflow service on
another host and point `TELEPOST_API_BASE_URL` at the telepost address — that is
[`remote-worker`](remote-worker.md).

---

## Resource requirements

| Profile | Combination | How |
| --- | --- | --- |
| `256m` | single bot, no executor | `docker compose up -d telepost`, `TELEPOST_MEMORY_LIMIT=256m` |
| `512m` (default) | two bots + executor | `TELEPOST_MEMORY_LIMIT=320m` + `PIXIVFLOW_MEMORY_LIMIT=192m` (or `256m`, see below) |
| `1g` | the above + search or the WebUI | Raise both `mem_limit`s, `SEARCH_ENABLED=true` |

Constraints: `bots<=2`, `search=disabled`, `download.concurrency=1`, no WebUI,
`NODE_OPTIONS=--max-old-space-size=96 --expose-gc`, `MALLOC_ARENA_MAX=2`, log rotation.
Full profiles and levers: [performance.md (中文)](/operations/performance.md).

> `.env.example` has `PIXIVFLOW_MEMORY_LIMIT=256m` while `docker-compose.yml` defaults to `192m`;
> the two sums correspond to whole-machine budgets of 576m and 512m. Treat the
> `docker-compose.yml` default as the baseline for the 512 MiB profile, and follow the table above
> when you set the values explicitly in `.env`.

---

## Lifecycle

| Role | Lifecycle | Who wakes it | Who decides to stop |
| --- | --- | --- | --- |
| `publisher` | `always-on` | not applicable | `restart: unless-stopped` |
| `telegram-ingress` | `always-on` | not applicable | same |
| `executor` | `always-on` | not applicable | same |
| `clock` | `always-on` | not applicable | not applicable |

Both containers are resident, and the lifecycle is decided by the host and the container restart
policy. There is **no** "who is responsible for waking" question here, and therefore no room for
`exitWhenIdle`: in `internal` mode the process is resident and the internal cron simply fires on
schedule.

Health checks are safe here, unlike on the `split-worker` executor: a probe cannot wake a container
that never stopped. In `docker-compose.yml`, telepost uses `/ready` as the dependency gate, and
pixivflow probes the trigger port when `SCHEDULER_TRIGGER_TOKEN` is set.

---

## Where state lives

| State | Path | Cost of loss |
| --- | --- | --- |
| TelePost per-bot SQLite | `./data/bot{N}/` | All submission idempotency and the review queue are lost |
| TelePost runtime policy overrides | `./data/bot{N}/runtime-policy.json` | Falls back to the deployment defaults in `.env` |
| PixivFlow slot ledger | `./data/pixivflow/pixivflow.db` | Selected works and occurrence records are lost |
| Download cache and metadata | relative paths under `./data/pixivflow/` | Must be downloaded again |
| Delivery outbox | same, files referenced by a manifest | Undelivered works are permanently lost |

**One volume, per-role subdirectories, no volume-level isolation.** Either container corrupting the
shared directory affects the other role.
Full inventory and backup rules: [state.md (中文)](/concepts/state.md) and
[backup.md (中文)](/operations/backup.md).

---

## Network

| Item | Value |
| --- | --- |
| `executor` → `publisher` | `container-network`, `http://telepost:8080` (the `TELEPOST_API_BASE_URL` default) |
| `telegram-ingress` | `polling`: no inbound port needed; the root API binds to `127.0.0.1:8080` only by default |
| `telegram-ingress` | `webhook`: `--profile webhook` starts Caddy; `WEBHOOK_DOMAIN` / `WEBHOOK_URL` point at the public domain |
| Egress | `direct`, or `--profile proxy` for the bundled Mihomo (`http://proxy:7890`) |

`NO_PROXY` / `no_proxy` already include `127.0.0.1`, `localhost`, `telepost`, `pixivflow` and
`proxy`, so internal delivery never goes out through the public internet or the proxy.

---

## Strengths

- **Easiest to deploy.** Fewest components, no external clock, no platform-specific configuration.
- **Local network communication.** Internal delivery never leaves the host, costs no public
  traffic and involves no private overlay.
- **One volume to back up.**
- **Platform independent.** Any machine that can run Docker Compose works; the systemd backend
  holds up equally when there is no Docker.
- **Health checks are usable.** Resident roles do not have to fear being woken by a probe.

---

## Weaknesses

- **Single failure domain.** Either role OOMing or crashing shares the machine, the memory and the
  startup scripts with the other role.
- **`executor` and `publisher` compete for memory.** The 512 MiB profile must hard-limit download
  concurrency, or one side gets OOM-killed.
- **The `executor` holds Telegram credentials.** Both roles share one machine and one volume, so
  the split-worker credential boundary **does not hold** here. The only way to get that boundary is
  to move to [`split-worker`](split-worker.md) or [`remote-worker`](remote-worker.md).
- **No saving mechanism.** The machine is billed resident; being idle saves nothing.

---

## Failure model

| Failure | Blast radius | Symptom | Recovery |
| --- | --- | --- | --- |
| `executor` OOM | Every role on the host feels the memory pressure | exit 137, the batch is interrupted | Raise the profile or lower concurrency; the slot ledger lets the next wake resume |
| `publisher` crash | User submissions unavailable | Direct-message submission looks broken | `restart: unless-stopped` restarts it automatically |
| Volume corruption | Both roles lose state together | Review queue and outbox disappear at the same time | Restore from a volume snapshot |
| Host reboot | Every role briefly unavailable | Containers restart in sequence | No manual intervention needed |
| Egress rate-limited by Pixiv | Only the `executor` is affected | `rate limit cooldown`, escalating penalty | Change egress or change host; see the [incident record (中文)](/incidents/2026-09-11-pixiv-egress-rate-limit.md) |

The failure domain is `single`. Any expectation that "one role can break while the other keeps
running" does not hold under this preset.

---

## Cost model

Host cost, resident. There is no idle-based saving and no per-execution billing.
There are only two ways to save: move to a cheaper host, or migrate to
[`split-worker`](split-worker.md) so the executor does not run by default.

---

## Deployment steps

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh          # generates .env and data/pixivflow/config.json
# edit .env: at least BOT1_TOKEN, BOT1_CHANNEL_ID, BOT1_OWNER_ID
# edit data/pixivflow/config.json: replace the example themes, adjust the Cron entries, set the plans you want to "enabled": true
./scripts/validate.sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

To skip the clone and use only the binary, use `deploy init`:

```bash
deploy init mybot && cd mybot
deploy doctor && deploy deploy
```

Full steps: [quickstart.md](../getting-started/quickstart.md) and
[docker.md](../platforms/docker.md).
For a Linux machine without Docker, see [vps.md](../platforms/vps.md).

---

## Migration paths

| Target | State that must move | Main actions |
| --- | --- | --- |
| `single-machine-worker-sleep` | The same `./data` directory | Switch to a resident supervisor spawning the executor on demand; **not implemented today**, read that preset's status fields first |
| `split-worker` | PixivFlow and TelePost state into two separate volumes | Two Fly configurations, one external clock; when rebuilding the executor, confirm the relative paths of the download cache |
| `remote-worker` | Only the executor state directory | Move the pixivflow service to a second host, change `TELEPOST_API_BASE_URL`, add authentication and a private network |

Reverse migration holds as well. The full data inventory and the non-migrated items are in
[migration.md (中文)](/architectures/migration.md).
