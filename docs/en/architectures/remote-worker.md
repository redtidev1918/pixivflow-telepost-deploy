# `remote-worker` — remote executor

| | |
| --- | --- |
| Support level | **Beta** |
| Implementation status | Implemented (two-host split in compose, `TELEPOST_API_BASE_URL`, cross-host Fly configuration), not end-to-end tested |
| Platforms | Docker Compose, systemd, Fly.io (may be mixed) |
| In one sentence | `executor` and `publisher` are not on the same machine, and may not even be on the same platform; they communicate over a private overlay network or public HTTPS. |

Machine-readable definition:
[`presets.remote-worker` in `architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json).

"Hybrid cloud / home node" is **not** a fifth preset; it is a placement choice within this preset.
The reason is in the last section of this page: one more preset means one more set of combinations
to verify, while its role ownership, state ownership and lifecycle change nothing.

---

## Who it is for

- People who already have several devices: one VPS + one home server.
- People running the service host on a mainland VPS and the `executor` on an overseas node (or the
  other way round).
- People who need special handling for Pixiv egress: the execution node sits on a machine whose
  egress is already qualified.
- People who want the executor on hardware they already own and only power machines on demand.

If you have only one machine, look at [`single-host`](single-host.md).
If you only want the reference implementation on Fly.io, look at
[`split-worker`](split-worker.md).

---

## Topology

```text
service-host (cloud or home)             executor-host (cloud or home, independent of service-host)
┌────────────────────────┐              ┌────────────────────────┐
│ publisher              │◄─────────────│ executor               │
│ telegram-ingress       │  submit API  │ clock                  │
│ resident               │  private     │ wake-run-exit or       │
│ own volume             │  overlay or  │ resident               │
│                        │  public HTTPS│ own volume             │
└────────────────────────┘              └────────────────────────┘
```

`clock` can be one of three things: `internal` on the service-host, `cloudflare` on a Cloudflare
Worker, or `external` — any timer that can send an authenticated POST (cron-job.org, EasyCron, a
cron entry on your own VPS).

### Placement combinations

| id | Example | Typical motivation |
| --- | --- | --- |
| `cloud-to-cloud` | VPS A runs TelePost, VPS B runs PixivFlow | Isolate resources and failure domains while staying in the cloud |
| `cloud-to-home` | Fly / a VPS runs TelePost, a home server runs PixivFlow | Execution on existing hardware, mainland home-broadband egress |
| `home-to-cloud` | A home server runs TelePost, a cloud VPS runs PixivFlow | Keep business data at home, execute from a clean egress |

All three are the same preset; only `units[].placement` and the transport differ.

---

## Resource requirements

| Unit | Requirement |
| --- | --- |
| `service-host` | Sized for the `publisher`: the `256m` profile for a single bot; two bots idle at about 170–230 MiB, peak 200–230 MiB |
| `executor-host` | ≥512 MiB; while running it is bounded by `--max-old-space-size` and `download.concurrency` |
| Network | Private overlay network, or public HTTPS; the two hosts' egress is independent |
| Proxy | Decided per host; the `executor-host` is the only host that genuinely needs Pixiv egress qualification |

The two hosts' resource profiles are independent of each other: `256m` on the `service-host` with
`512m` on the `executor-host` is a legal combination (see `resourceProfiles` in the matrix).

---

## Lifecycle

| Role | Lifecycle | Who wakes it | Who decides to stop |
| --- | --- | --- | --- |
| `clock` | `always-on` | not applicable | not applicable |
| `executor` | `wake-run-exit` or `always-on` (per platform capability) | the clock; under `wake-run-exit` it is the trigger request | under `wake-run-exit` it is the `executor`'s own ledger |
| `publisher` | `always-on` | never sleeps | never stops |
| `telegram-ingress` | `always-on` | never sleeps | never stops |

`wake-run-exit` is available only where the platform supports "a stopped machine is woken by an
inbound request". Docker Compose and bare-metal systemd do not, so on those two paths the
`executor` uses `always-on` + `clock=internal`; to get the cost saving of `wake-run-exit`, host the
`executor-host` on Fly.io.

Whichever combination you pick, **the `executor`'s stop decision always reads its own ledger**. The
host's `docker stop`, a platform's idle inference and a supervisor's timeout cannot replace it.

---

## Where state lives

| State | Location | Notes |
| --- | --- | --- |
| TelePost per-bot SQLite | the `service-host` volume, `data/bot{N}/` | Submission idempotency, review queue, publication records |
| TelePost runtime policy overrides | `data/bot{N}/runtime-policy.json` | Written atomically by the OWNER through `/botconfig` |
| PixivFlow slot ledger | the `executor-host` volume, `pixivflow.db` | occurrence, slot, slot item |
| Download cache and metadata | the `executor-host` volume | Storage paths must stay relative |
| Delivery outbox | the `executor-host` volume | Survives restarts, references downloaded files |

**One volume per host, never shared.** Sharing a filesystem across hosts turns a network failure
into state corruption, and this preset explicitly does not support it.

---

## Network

| Link | Recommended | Notes |
| --- | --- | --- |
| `executor` → `publisher` | private overlay network (Tailscale / WireGuard) | No public port exposed; delivery never leaves the overlay |
| Alternative | public HTTPS + reverse proxy | Bearer auth must be enabled; do not expose the submission port raw |
| Telegram → `publisher` | `webhook` (public HTTPS) or `polling` | Both expose the same `api/botN/v1/*` surface; the delivery configuration does not change with the ingress mode |
| `executor` egress | decided independently | Egress qualification must be obtained separately |

Configuration that must be kept:

```dotenv
# executor-host
TELEPOST_API_BASE_URL=https://<service-host>            # or http://<overlay-name>:8080
TELEPOST_BOT1_SUBMIT_TOKEN=...                          # required even over a private network
```

`NO_PROXY` / `no_proxy` must contain the reachable name of the `publisher`, otherwise delivery
leaves for the public internet through the proxy: slow, and it fails when the proxy is unavailable.

**A private network is not authentication.** An overlay solves reachability, not authorisation; the
submission API bearer token must stay enabled once the two hosts are apart. This is the single most
important configuration difference between this preset and `single-host`.

---

## Strengths

- **Egress can be chosen deliberately.** The `executor-host` can sit on a machine whose egress is
  already qualified for Pixiv, decoupled from the service side. This is the core benefit of the
  preset over the other three.
- **Existing hardware can be reused.** The executor runs on a server you already have, with no extra
  cloud resources.
- **Business data and execution data are physically separated.** The review queue and the download
  cache are not on the same machine.
- **Not bound to a platform.** The two roles may run on different platforms (for example Fly for the
  service, a home server for execution).
- **Failure domains are separated**, on a par with `split-worker`.

---

## Weaknesses

- **Across a network boundary.** One more overlay or reverse proxy is one more class of failure:
  DNS, certificates, MTU, the overlay coordination service.
- **Two hosts to operate.** Backup, upgrades and monitoring must cover both.
- **Latency.** Delivery crosses the network; home-egress uplink bandwidth can be the bottleneck.
- **The `executor-host` cannot inherit egress quality.** The service side working does not mean the
  executor side works (see the [incident record (中文)](/incidents/2026-09-11-pixiv-egress-rate-limit.md)).
- **Not end-to-end tested.** The support level is `beta`, not `stable`.
- **More clock choices.** Which side holds `internal`, and whether an external clock is needed, are
  decisions you must make explicitly; a wrong configuration yields "nothing ran" rather than an
  error.

---

## Failure model

| Failure | Blast radius | Symptom | Recovery |
| --- | --- | --- | --- |
| Overlay network down | `executor` → `publisher` delivery fails | The outbox accumulates and retries with exponential backoff | Drains automatically once the network returns; no work is lost |
| `executor-host` crash | Only the execution plane | The batch is interrupted | The ledger lets the next wake resume |
| `service-host` crash | User-visible | Direct-message submission unavailable | Restart the resident service |
| Egress rate-limited by Pixiv | Only the execution plane | `rate limit cooldown`, escalating penalty | Change egress and requalify |
| Two clocks active at once | Two executions contend for the same Pixiv credential | Rate limiting, escalating penalty, duplicate triggering | Keep exactly one clock |
| Missing submit token | Every delivery is a 401 | The outbox accumulates fast | Add `TELEPOST_BOT{N}_SUBMIT_TOKEN` |
| Host clock drift | occurrence computation shifts | Runs execute at the wrong time | Enable NTP on both ends; with `clock=internal` the drift only affects its own side |

The failure domain is `separated, across a network boundary`: the isolation is the best of the four,
but it introduces a class of failure `split-worker` does not have (the network boundary itself).

---

## Cost model

| Item | Notes |
| --- | --- |
| Two hosts | Billed independently |
| Source of saving | Putting the `executor` on a cheap or already-owned machine; or letting it `wake-run-exit` on a platform that supports waking |
| Extra costs | The overlay service (if a managed one is used), public bandwidth, possibly a reverse-proxy host |

Versus `single-host`: one more machine, in exchange for egress freedom and failure isolation.
Versus `split-worker`: no extra machine, in exchange for platform freedom.

---

## Deployment steps

### Option 1: Docker Compose across two hosts

The header comment of `docker-compose.yml` is exactly this option: the default is "one combined
host", and to "split into two" you deploy the `pixivflow` service to another host.

```bash
# on the service-host: start the publisher only
docker compose up -d telepost

# on the executor-host: deploy pixivflow and point the delivery base at the service-host
TELEPOST_API_BASE_URL=https://<service-host>      # or http://<overlay-name>:8080
TELEPOST_BOT1_SUBMIT_TOKEN=...
PIXIV_REFRESH_TOKEN=...
```

### Option 2: a Fly executor + any service side

The delivery and trigger addresses in `fly/deploy.pixivflow.toml` are replaceable: point
`TELEPOST_API_BASE_URL` at your own business host and `PIXIVFLOW_TRIGGER_BASE_URL` (in
`control-plane/wrangler.toml`) at this Fly app. The two Fly configurations are no longer the only
source of topology; this preset allows splitting on demand.

### Option 3: systemd on both ends

`deploy --platform systemd` installs the TelePost supervisor on bare-metal Linux and lets you
choose whether to enable the same-machine PixivFlow. Disable the same-machine PixivFlow and run the
executor independently on a second machine, and you have this preset.

Full commands: [docker.md](../platforms/docker.md), [vps.md](../platforms/vps.md),
[flyio.md](../platforms/flyio.md).

### Mandatory post-deployment checks

1. From the `executor-host`, a token-carrying delivery reaches the `service-host` submission API.
2. An unauthorised delivery is rejected (401) rather than blocked at the network layer and merely
   appearing to succeed.
3. The `executor`'s egress is usable on each of the three Pixiv data surfaces:
   `oauth.secure.pixiv.net`, `app-api.pixiv.net`, `i.pximg.net` (with
   `Referer: https://app-api.pixiv.net/`).
4. Exactly one clock is firing this schedule set.
5. Both volumes are covered by their respective backup processes.

---

## Migration paths

| Source | Target | Main actions |
| --- | --- | --- |
| `single-host` | this preset | Move the `executor` container and its state directory to a second host; change `TELEPOST_API_BASE_URL`; establish the private network and keep bearer auth |
| `split-worker` | this preset | Change platform or hosts; keep the "two roles, two machines, two volumes" shape; reconfigure the transport |
| this preset | `single-host` | Merge two machines into one; point `TELEPOST_API_BASE_URL` back at `http://telepost:8080`; confirm loopback delivery bypasses the proxy |
| this preset | `split-worker` | Converge on the Fly reference implementation; add an external clock; switch the executor to `wake-run-exit` |

Data inventory: [migration.md (中文)](/architectures/migration.md).

---

## Why there is no fifth "hybrid cloud" preset

"Cloudflare = clock + Fly = TelePost + a home server = PixivFlow" looks like a new architecture, but
all it changes is `units[].placement`: the roles do not change, state ownership does not change, the
lifecycle does not change, the credential boundary does not change. Making it a fifth preset would
give you:

```text
4 presets × N placement combinations → the number of combinations to verify grows multiplicatively
```

This repository's choice is:

```text
a small number of verified presets  +  a limited set of feature switches  +  explicit placement combinations
```

So "hybrid cloud / home node" is expressed as `remote-worker` plus a placement table, not as a new
preset. That is also the direct application of the "do not manufacture arbitrary combinations" rule
in [overview.md](overview.md).
