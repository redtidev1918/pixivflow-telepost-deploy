# PixivFlow + TelePost Deploy

**Language / 语言:** [中文](README.md) · English

[![Validate](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml)
[![Release](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/Docs-documentation_site-6366f1?style=flat-square)](https://redtidev1918.github.io/pixivflow-telepost-deploy/)

A deployment kit built for running Pixiv auto-posting for real. It wires two upstream projects
into one deployable system:

| Component | Owns | Does not own |
| --- | --- | --- |
| [PixivFlow](https://github.com/redtidev1918/PixivFlow) | Fetching works by theme/ranking, selection, downloads, reliable delivery | Anything Telegram-channel related |
| [TelePost](https://github.com/redtidev1918/TelePost) | Receiving submissions, human review, publishing to channels | Pixiv login or scheduling |

**One business model; several deployment topologies.** The same business semantics can run on
one VPS, on one 512 MiB machine, or split across two machines. What changes is where roles run,
which of them may sleep, who wakes whom, and who holds credentials — not the review flow or the
scheduling semantics.

---

## Which deployment should I pick?

| Your situation | Pick |
| --- | --- |
| I have one VPS / NAS / home machine | `single-host` |
| I only have one 512 MiB Fly Machine | `single-machine-worker-sleep` (**designed only, not implemented today**) |
| I want the lowest Fly bill | `split-worker` |
| Reliability matters most | `split-worker` |
| I have a VPS + a home server | `remote-worker` |
| Pixiv egress quality matters most | `remote-worker` |
| I just want it running as fast as possible | `single-host` |

```text
Only one machine?
├─ Yes
│  ├─ RAM >= 1 GiB ─────────────────► single-host
│  ├─ RAM = 512 MiB
│  │  ├─ Save RAM, accept always-on machine billing ─► single-machine-worker-sleep
│  │  └─ Save the bill ─────────────► split-worker
│  └─ RAM = 256 MiB ────────────────► single-host, service roles only
└─ No
   ├─ Using Fly.io ──────────────────► split-worker
   └─ Already have multiple nodes ───► remote-worker
```

The full comparison table, commonly misconfigured combinations, and the most common confusion —
**process sleep is not machine sleep** — are in
[**Which deployment should I pick?**](docs/en/getting-started/choose-architecture.md).

---

## Quickstart (default `single-host`)

Requires Docker 24+ and Compose v2.

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh                 # generates .env and data/pixivflow/config.json
# Edit .env: set at least BOT1_TOKEN, BOT1_CHANNEL_ID, BOT1_OWNER_ID
# Edit data/pixivflow/config.json: your tags, cron settings, and set plans to "enabled": true
./scripts/validate.sh
docker compose up -d
curl http://127.0.0.1:8080/health
```

Don't want to clone the repo? `deploy` is a single Go binary (Windows / macOS / Linux, no runtime
dependencies) — three commands deploy to a fresh machine:

```bash
deploy init mybot                        # wizard-generated deployment directory
cd mybot
deploy doctor && deploy deploy          # self-checks, then one-command deploy
```

Download the `deploy-<os>-<arch>` binary from
[Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases).

**Full steps, verification checklist, and entry points for the other presets**:
[Quickstart](docs/en/getting-started/quickstart.md).

---

## Features

- **Automatic themed posting**: fetch "yesterday's hottest" by Pixiv theme (tag-space derivation)
  or daily rankings; take the top N illustrations and novels each; exclude AI works using Pixiv's
  official `illust_ai_type` flag.
- **Chinese-language novel filtering**: `franc-min` language detection plus
  `strictLanguageFilter` — Chinese novels only.
- **Review group + reply chains**: multi-page sets are packed into albums of up to 10 images,
  chained together via automatic replies; after approval, `file_id`s are reused so nothing is
  uploaded twice. **Nothing reaches a channel before a human approves it.**
- **Full caption templates**: title / description / tags / source link / spoiler policy are all
  templatable; tags are sanitised into clickable hashtags.
- **Multiple network modes**: polling / webhook / optional proxy, one `api/botN/v1/*` surface.
- **Low-memory friendly**: runs in 512 MiB; small albums with automatic single-image fallback on
  failure, forced GC per page, tunable health-check parameters.
- **No silent failures, no duplicates**: even an empty result notifies the review group; a
  persistent outbox prevents lost deliveries; SQLite idempotency keys prevent duplicates after
  restarts.

---

## Supported deployment architectures

| Preset | Support level | Status | In one sentence |
| --- | --- | --- | --- |
| [`single-host`](docs/en/architectures/single-host.md) | Stable | implemented, CI-covered | One machine runs every role |
| [`single-machine-worker-sleep`](docs/en/architectures/single-machine-worker-sleep.md) | Experimental | **designed only, not implemented** | One machine; the executor process spawns on demand and exits when idle |
| [`split-worker`](docs/en/architectures/split-worker.md) | Stable | implemented, tested, **current production** | Executor and service each get a machine and a volume |
| [`remote-worker`](docs/en/architectures/remote-worker.md) | Beta | implemented, no end-to-end test | The two roles run across machines and networks |

Each preset page has a fixed section order: who it is for, topology, resource requirements,
lifecycle, where state lives, network, strengths, weaknesses, failure model, cost model,
deployment steps, and migration paths.

The machine-readable authority (roles, presets, support levels, feature switches, legal and
illegal combinations, resource profiles, security invariants) is
[`docs/reference/architecture-matrix.json`](docs/reference/architecture-matrix.json);
`architecture_docs_test.go` enforces in CI that the documentation matches it.

---

## Three concepts that must not be conflated

```text
Logical architecture (fixed)   Who owns which decision — independent of deployment method
Deployment topology (variable) Where roles run, who may sleep, who wakes whom
Resource profile (variable)    How much RAM each running unit gets
```

- **The `executor` never owns Telegram tokens, channels, or review decisions.** Co-location is a
  physical fact; ownership never merges. See the [role contract (Chinese)](docs/concepts/roles.md).
- **The `publisher` never sleeps**: a cold-starting submission bot is, from the user's point of
  view, a broken bot.
- **Process sleep is not machine sleep; saving RAM is not saving the compute bill.**
  See [lifecycle (Chinese)](docs/concepts/lifecycle.md).

---

## Documentation

Docs site: <https://redtidev1918.github.io/pixivflow-telepost-deploy/>
(Chinese is authoritative; English mirrors cover the choose-an-architecture, deploy, and operate
paths.)

| I want to… | Read |
| --- | --- |
| Decide which deployment to use | [Choose an architecture](docs/en/getting-started/choose-architecture.md) |
| Get the first bot running from zero | [Quickstart](docs/en/getting-started/quickstart.md) |
| Understand roles and ownership | [Role contract (Chinese)](docs/concepts/roles.md) |
| Understand sleep, wake, shutdown | [Lifecycle (Chinese)](docs/concepts/lifecycle.md) |
| Understand scheduling and slot idempotency | [Scheduling (Chinese)](docs/concepts/scheduling.md) |
| Know where credentials live and where the boundary is | [Credentials (Chinese)](docs/concepts/credentials.md) |
| Deploy to Fly.io | [Fly.io](docs/en/platforms/flyio.md) |
| Deploy to a VPS | [Docker](docs/en/platforms/docker.md) / [VPS and bare metal](docs/en/platforms/vps.md) |
| Out of memory / OOM | [Performance and memory (Chinese)](docs/operations/performance.md) |
| Troubleshooting | [Troubleshooting (Chinese)](docs/operations/troubleshooting.md) |
| Move from one architecture to another | [Migration contract (Chinese)](docs/architectures/migration.md) |
| The authority for each concept | [Deployment contract](docs/en/reference/deployment-contract.md) |
| The multi-architecture plan | [Roadmap (Chinese)](docs/ROADMAP-MULTI-ARCH.md) |

All pages: [documentation index](docs/en/README.md).

---

## Layout

```text
deploy.go / init.go / go.mod     One-command deployment tool (single Go binary, shipped in releases)
deploy_test.go                   CLI tests
architecture_docs_test.go        Documentation consistency tests (presets / matrix / links / contract)
docker-compose.yml               compose topology: telepost + pixivflow + optional Caddy / Mihomo
fly/deploy.telepost.toml         Single topology source for the service (always-on)
fly/deploy.pixivflow.toml        Single topology source for the executor (stopped by default, exits after runs)
control-plane/                   Cloudflare thin clock: cron -> schedule id -> one authenticated POST
docker/                          Image definitions (passthrough, commit-pinned scheduler, single-host combined)
pixivflow/config/*.example.json  Safe templates for multiple schedules
config/                          Non-sensitive channel/review policy templates
scripts/                         Bootstrap, validation, read-only production checks
docs/                            Documentation: architectures, concepts, platforms, operations, reference
proxy/                           Optional Mihomo image
data/                            Databases, download cache, outbox, live config (not committed)
```

---

## Security boundaries

- `.env`, `data/`, `proxy-data/`, and upload temp files are gitignored.
- Bot tokens, Pixiv refresh tokens, submission tokens, and proxy subscription URLs live only in
  `.env` or platform secrets — never in JSON templates, Git history, or chat screenshots.
- Under `split-worker` and `remote-worker`, the executor holds **no Telegram tokens or channel
  IDs**, so it cannot post to a channel directly, bypass review, or become the webhook owner.
  Under `single-host` and `single-machine-worker-sleep` the two roles share one machine, so this
  boundary **does not hold**. `control-plane/test/webhook-ownership.test.ts` statically guards the
  former.
- The Telegram webhook has exactly one owner: TelePost registers it at startup; no script in this
  repository ever registers it.
- The root API binds to `127.0.0.1` by default; webhook ingress goes through a reverse proxy.
- If a credential has ever entered an issue, log, screenshot, or Git history, rotate it
  immediately — automated checks are no substitute for rotation.

Full rules: [credentials (Chinese)](docs/concepts/credentials.md), [SECURITY.md](SECURITY.md).

---

## Contributing

- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
  (after changes, run `go test ./...`, `./scripts/validate.sh --examples`, and
  `(cd control-plane && npm test)`)
- Usage and troubleshooting: [SUPPORT.md](SUPPORT.md)
- Private vulnerability reports: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

Upstream projects: [PixivFlow](https://github.com/redtidev1918/PixivFlow) ·
[TelePost](https://github.com/redtidev1918/TelePost)

## License

[MIT](LICENSE)

This project is not affiliated with or officially endorsed by Pixiv, Telegram, or Fly.io.
Operators should only process content they have the right to download, store, and publish, and must
comply with platform terms, copyright requirements, and local law. The project neither sets
channel content policy on an operator's behalf nor provides any guarantee of evading platform
restrictions or regulation.
