# PixivFlow + TelePost Deploy

**Language / 语言:** [中文](README.md) · English

> **Deployment and operations toolkit for PixivFlow + TelePost.** It wires the two upstream
> projects into one deployable, operable system:

📖 [Full documentation](https://redtidev1918.github.io/pixivflow-telepost-deploy/)

[![Validate](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml)
[![Release](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/Docs-documentation-6366f1?style=flat-square)](https://redtidev1918.github.io/pixivflow-telepost-deploy/)

| Component | Owns | Does not own |
| --- | --- | --- |
| [PixivFlow](https://github.com/redtidev1918/PixivFlow) | Fetching works by theme/ranking, selection, downloads, reliable delivery | Anything Telegram-channel related |
| [TelePost](https://github.com/redtidev1918/TelePost) | Receiving submissions, human review, publishing to channels | Pixiv login or scheduling |

**PixivFlow and TelePost are both usable on their own**, each with its own documentation,
installation path, and deployment options. This repository is only needed when you want to compose
the two into one complete workflow — it does not reimplement either side's business logic, it only
deploys, composes, and operates them.

## Who this is for

- **For you** if you want the "collect from Pixiv automatically" half and the "human review, then
  publish to a Telegram channel" half running as one long-lived workflow, with reproducible
  deployment (Docker / VPS / Fly.io), pinned versions, operations scripts, and architecture
  contracts.
- **Not for you** if you only want to download and filter Pixiv content — use
  [PixivFlow](https://github.com/redtidev1918/PixivFlow)'s own install and Docker docs; if you only
  want a Telegram submission/review bot — grab a
  [TelePost](https://github.com/redtidev1918/TelePost) release binary; or if you are just trying one
  of the two projects out.

**One business model; several deployment topologies.** The same business semantics can run on
one VPS, on one 512 MiB machine, or split across two machines. What changes is where roles run,
which of them may sleep, who wakes whom, and who holds credentials — not the review flow or the
scheduling semantics.

---

## Which deployment should I pick?

| Your situation | Pick |
| --- | --- |
| I have one VPS / NAS / home machine | `single-host` |
| I only have one 512 MiB Fly Machine | `single-machine-worker-sleep` (**not deployable yet**: orchestration implemented, image and platform config missing) |
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

## What the composed system does

The capabilities below describe the two upstream projects working together. Each one is implemented
upstream: discovery, selection, downloads, and delivery belong to
[PixivFlow](https://github.com/redtidev1918/PixivFlow); receiving submissions, human review, and
publishing belong to [TelePost](https://github.com/redtidev1918/TelePost). This repository deploys
and operates them.

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
| [`single-machine-worker-sleep`](docs/en/architectures/single-machine-worker-sleep.md) | Experimental | **process orchestration implemented (`supervisor/`), preset not deployable yet** | One machine; the executor process spawns on demand and exits when idle |
| [`split-worker`](docs/en/architectures/split-worker.md) | Stable | implemented, tested, **current production** | Executor and service each get a machine and a volume |
| [`remote-worker`](docs/en/architectures/remote-worker.md) | Beta | implemented, no end-to-end test | The two roles run across machines and networks |

Each preset page has a fixed section order: who it is for, topology, resource requirements,
lifecycle, where state lives, network, strengths, weaknesses, failure model, cost model,
deployment steps, and migration paths.

The machine-readable authority (roles, presets, support levels, feature switches, legal and
illegal combinations, resource profiles, security invariants) is
[`docs/reference/architecture-matrix.json`](docs/reference/architecture-matrix.json);
`architecture_docs_test.go` enforces in CI that the documentation matches it.

### Production scheduling

```text
cron-job.org ─┐
              ├─► PixivFlow trigger endpoint ─► slot ledger (the single execution authority)
Cloudflare  ──┘
```

**One clock is enough** for a simple deployment. For production `split-worker` deployments,
**two independent external clocks are recommended**: a PRIMARY (cron-job.org) that fires at the
scheduled time, and a SECONDARY (Cloudflare Cron) that fires again 2 minutes later. Both send the
same authenticated, idempotent trigger, and whichever arrives second converges on the same slot —
**a duplicate trigger never runs twice**.

The benefits are all operational: **no dedicated scheduler VM to maintain**, **no dependency on a
VM that can expire and needs manual renewal** (a VPS / systemd timer is for development, manual
troubleshooting and an emergency trigger), and two **low-maintenance**, **provider-independent**
clocks so that one provider failing silently no longer means that scheduled run disappears. A clock
holds only the trigger credential, so a leak only requires rotating that one credential.

This is the recommendation for the production `split-worker` deployment, not a requirement for
single-machine deployments: `single-host` and local/personal deployments need one clock only, and
do not have to sign up for two SaaS providers. Operating details:
[scheduling runbook (中文)](docs/operations/scheduling.md).

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

[Docs site](https://redtidev1918.github.io/pixivflow-telepost-deploy/)
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
supervisor/                      On-demand process orchestration for single-machine-worker-sleep (Go)
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

## Related projects

| Project | What it is | How it relates to this repo |
| --- | --- | --- |
| [PixivFlow](https://github.com/redtidev1918/PixivFlow) | Pixiv downloader, filter and automatic collection tool: batch downloads, scheduling, reliable HTTP delivery | The upstream executor this repo deploys. It is fully standalone; running it alone needs nothing from here |
| [TelePost](https://github.com/redtidev1918/TelePost) | Telegram channel submission, moderation and automated publishing platform: chat, Mini App, multi-bot, HTTP API | The upstream publisher this repo deploys. It is also fully standalone (a release binary is enough) |

## License

[MIT](LICENSE)

This project is not affiliated with or officially endorsed by Pixiv, Telegram, or Fly.io.
Operators should only process content they have the right to download, store, and publish, and must
comply with platform terms, copyright requirements, and local law. The project neither sets
channel content policy on an operator's behalf nor provides any guarantee of evading platform
restrictions or regulation.

## Acknowledgements

This deployment toolkit builds on two upstream projects:
[PixivFlow](https://github.com/redtidev1918/PixivFlow) (fetching, selection, downloads, delivery) and
[TelePost](https://github.com/redtidev1918/TelePost) (submissions, review, channel publishing) —
each usable on its own; this repository only wires them into a deployable, operable system.
The runtime plane relies on [Docker Compose](https://docs.docker.com/compose/) and
[Fly.io](https://fly.io); scheduling and egress trade-offs are covered in the docs site's platform pages.
