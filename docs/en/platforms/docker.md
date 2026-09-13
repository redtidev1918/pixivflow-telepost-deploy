# Docker / Docker Compose (single host, all-in-one)

> **This page is the authoritative how-to for running the whole service on one machine with
> Compose**, for preset [`single-host`](../architectures/single-host.md). It also absorbs and
> replaces the old `SCENARIOS.md`, `POLLING.md` and `WEBHOOK.md`. Compose describes a
> **single-host topology**; to split across two machines see
> [remote-worker.md](../architectures/remote-worker.md), for Fly see [flyio.md](./flyio.md).

## Who it is for

One VPS / NAS / home server / workstation where you want the whole service running with the fewest
components.

## What you need

- Docker 24+ and Compose v2
- Linux/macOS (or Git-Bash)
- 512 MiB to start; 256 MiB only supports one bot and no executor

## Topology

`docker-compose.yml` defines two independent services + two optional profiles:

```text
One Host
├─ telepost        (service side: resident, the only holder of the Telegram token)
├─ pixivflow       (executor: same machine, delivery over the container network)
├─ caddy           (optional webhook profile: public HTTPS)
└─ proxy           (optional proxy profile: bundled Mihomo)
        ↑ shares the ./data volume and the app network
```

The matrix records `single-host` as `stateLayout = shared-volume`, `state = own + own` (two roles
on one machine, each with its own subdirectory but the same volume): this is a **documented
limitation**, not an error. See [state.md (中文)](/concepts/state.md).

## Fastest start

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh          # generates .env and data/pixivflow/config.json
# edit .env: fill in at least BOT1_TOKEN / BOT1_CHANNEL_ID / BOT1_OWNER_ID
./scripts/validate.sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

Windows manual equivalent: copy `.env.example` → `.env`, copy
`pixivflow/config/fly-two-bots.example.json` → `data/pixivflow/config.json`.

## Three network modes

| Machine | How to start | TelePost mode |
| --- | --- | --- |
| No public address, Telegram/Pixiv reachable directly | `docker compose up -d` | AUTO picks polling |
| Domain available, inbound 80/443 open | `docker compose --profile webhook up -d` | AUTO picks webhook |
| Mainland network needs a proxy | `docker compose --profile proxy up -d` | polling + Mihomo |

The `deploy init` wizard asks about the scenarios above (Enter keeps polling) and writes the
matching `.env` plus the suggested commands; it needs only Docker and the single binary — no
repository clone, no bash or python.

Polling and Webhook expose **the same** `http://127.0.0.1:8080/api/botN/v1/*`, so the executor's
delivery configuration does not change with the ingress mode. When webhook registration fails,
AUTO falls back to polling. Ingress modes and their invariants: [network.md (中文)](/concepts/network.md).

### Polling (no public ingress)

Default `RUN_MODE=AUTO` with an empty `WEBHOOK_URL` → long polling. The root API binds only to
`127.0.0.1:8080` (`BIND_ADDRESS`); do **not** expose 8080 to the public internet. TelePost reaches
out to Telegram, so no inbound port, domain or certificate is needed, and the internal delivery to
`http://127.0.0.1:8080/api/botN/v1/submissions` bypasses the proxy and consumes no public bandwidth.

```bash
curl http://127.0.0.1:8080/health
curl -H "Authorization: Bearer $TELEPOST_BOT1_SUBMIT_TOKEN" \
  http://127.0.0.1:8080/api/bot1/v1/health
# an external machine should tunnel in rather than publish 8080:
ssh -L 18080:127.0.0.1:8080 user@server
```

### Webhook (public HTTPS)

Point the domain's A/AAAA records at the server, open TCP 80/443 and UDP 443, then:

```dotenv
RUN_MODE=AUTO
WEBHOOK_DOMAIN=bot.example.com
WEBHOOK_URL=https://bot.example.com
```

```bash
docker compose --profile webhook up -d
docker compose logs -f caddy telepost
curl https://bot.example.com/health
```

Caddy issues and renews certificates automatically; TelePost registers a separate `/webhook/botN`
path per bot. **The webhook owner is always and only TelePost** (`SI-2`). Verify:

```bash
BOT1_TOKEN=... ./scripts/verify-webhooks.sh
```

Security advice: keep `BIND_ADDRESS=127.0.0.1` and never expose 8080 separately; open only Caddy's
80/443. If you already run Nginx, Traefik or a Cloudflare Tunnel, do not start the `webhook`
profile — point your existing reverse proxy at `127.0.0.1:8080` instead.

## Run once by hand (without waiting for cron)

```bash
# on the machine that runs it, verify the "yesterday's most popular + topic-matching tag" path:
docker compose exec pixivflow pixivflow download --config /app/data/pixivflow/config.json
```

## Remote changes / upgrades

Under Compose `watchConfig = true`: PixivFlow watches `data/pixivflow/config.json`, and once the
file validates it swaps the schedule table atomically — no restart. A TelePost OWNER can change the
current bot's policy with `/botconfig`. Upgrading:

```bash
./deploy tp latest     # TelePost
./deploy pf 2.10.31    # PixivFlow to a specific version
# or edit .env and run docker compose up -d
```

In production, pin `TELEPOST_IMAGE` / `PIXIVFLOW_IMAGE` to explicit release tags rather than
`latest`. Details: [upgrades.md (中文)](/operations/upgrades.md).

## Resources and limits

Compose allocates by default against a machine-wide 512 MiB budget: **telepost 320m + pixivflow
192m** (`mem_limit` is adjustable). Constraints (see [environment.md (中文)](/reference/environment.md)):

- At most two bots, with search and the WebUI off (`SEARCH_ENABLED=false`, `simple` tokenizer).
- `download.concurrency=1`; several schedules in the same cron slot queue up serially — space them
  15–20 minutes apart when it is tight.
- To reuse downloaded content, use `storageMode=cache` + `delivery.deleteAfterDelivery=false` and
  set `cacheRetentionDays=7` / `cacheMaxSizeMB=384`; the outbox is kept separately.
- Keep log rotation, the 96 MiB Node heap and a small SQLite cache.

**Do not delete failed cache/outbox entries to buy a lower-looking footprint** (see
[troubleshooting.md (中文)](/operations/troubleshooting.md)).

## How it differs from the production topology

Compose is **all-in-one on one machine**: one failure domain, one shared volume, executor and
service side co-located. Current Fly production is [`split-worker`](../architectures/split-worker.md)
(two machines, two volumes, credential boundary holds). Their business semantics are identical —
only the deployment facts differ, which is the core of this kit's upgrade from "the only production
topology" to a deployment matrix. Migration path: [migration.md (中文)](/architectures/migration.md).

## Related pages

- Single-host preset: [single-host.md](../architectures/single-host.md)
- Network and egress: [network.md (中文)](/concepts/network.md)
- Proxy container: [proxy.md](./proxy.md)
- Environment variables and profiles: [environment.md (中文)](/reference/environment.md)
