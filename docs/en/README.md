# PixivFlow + TelePost Deploy — Documentation

Language / 语言: [中文](/) · English

This is the deployment kit that wires [PixivFlow](https://github.com/redtidev1918/PixivFlow)
(download scheduler) together with [TelePost](https://github.com/redtidev1918/TelePost)
(Telegram review/publish bot), shipped as a Go `deploy` CLI plus Docker Compose and Fly.io
backends.

**The core business model is one model; a deployment topology is one of several legal
implementations of it.** Role ownership, state ownership and lifecycle semantics do not change
with the deployment method. Only where roles run, which of them may sleep, who wakes whom, and
who holds credentials change. The authority for the role contract is the
[role model (中文)](/concepts/roles.md).

The `deploy` one-click deployment tool (a single binary) is on the
[download page](download.md), which points at the latest Release tarball for every platform.

## Three reading paths

| Who you are | Start here |
| --- | --- |
| **User**: you want it running | [Which deployment should I pick?](getting-started/choose-architecture.md) → [Quickstart](getting-started/quickstart.md) → a platform page |
| **Operator**: it is already running | [Monitoring and read-only checks (中文)](/operations/monitoring.md) → [Troubleshooting (中文)](/operations/troubleshooting.md) → [Upgrades (中文)](/operations/upgrades.md) |
| **Agent / contributor**: you want to change something | [AGENTS.md](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/AGENTS.md) → [Deployment contract](reference/deployment-contract.md) → [Architecture matrix](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json) → the specific page |

## Translation policy

| Rule | Detail |
| --- | --- |
| Authority | Chinese is authoritative. If an English page and its Chinese counterpart disagree, the Chinese page wins. |
| Mirrored set | English pages are maintained only for the paths listed in `documentation.mirroredPages` of [`docs/reference/architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json): `README.md`, `getting-started/choose-architecture.md`, `getting-started/quickstart.md`, `architectures/overview.md`, `architectures/single-host.md`, `architectures/single-machine-worker-sleep.md`, `architectures/split-worker.md`, `architectures/remote-worker.md`, `reference/deployment-contract.md`, `platforms/docker.md`, `platforms/vps.md`, `platforms/flyio.md`, `platforms/cloudflare.md`, `platforms/proxy.md`, `download.md`. |
| Chinese-only pages | Every page outside that set is Chinese-only: the whole `concepts/` and `operations/` trees, `architectures/migration.md`, `reference/environment.md`, `incidents/` and `ROADMAP-MULTI-ARCH.md`. English pages link to them under their Chinese site path and mark the link `(中文)`, for example [role contract (中文)](/concepts/roles.md). |
| Parity | Every file under `docs/en/` must have a Chinese counterpart at the same path under `docs/`, and every mirrored page must exist in both trees. `architecture_docs_test.go` enforces both directions. |

There is no `docs/en/concepts/` or `docs/en/operations/` tree — do not create one.

## Architecture presets

Four presets exist. Their names are identical in the matrix, in the deployment contract and in every
architecture page; `architecture_docs_test.go` enforces that.

| Preset | Support level | Implementation status | In one sentence | Docs |
| --- | --- | --- | --- | --- |
| `single-host` | Stable | implemented, CI-covered, not production-proven | One machine runs every role: TelePost and PixivFlow as separate containers, sharing one `data` directory. | [single-host.md](architectures/single-host.md) |
| `single-machine-worker-sleep` | Experimental | **components implemented, preset not deployable** | One machine: the service stays resident, the executor exists as a child process only while there is work and exits when idle. | [single-machine-worker-sleep.md](architectures/single-machine-worker-sleep.md) |
| `split-worker` | Stable | implemented, tested, **current production** | The executor and the service each get their own machine and volume. | [split-worker.md](architectures/split-worker.md) |
| `remote-worker` | Beta | implemented, no end-to-end test | The two roles communicate across machines and networks. | [remote-worker.md](architectures/remote-worker.md) |

Entry points: the [preset matrix](architectures/overview.md) and
[which deployment should I pick?](getting-started/choose-architecture.md).

Support level and implementation status are different things and are never merged into one word:

| Support level | Meaning |
| --- | --- |
| `stable` | Contract frozen; its behaviour may be relied on. The matrix enforces that `stable` is also `implemented` and `tested`. |
| `beta` | Implemented, interface may still change, end-to-end evidence missing. |
| `experimental` | The design exists; the implementation may not. Read the matrix `status` before using it. |
| `deprecated` | Explanation and migration path kept, no more fixes. No preset is at this level today. |

| Status field | Meaning |
| --- | --- |
| `documented` | Executable documentation exists, with no undefined behaviour. |
| `implemented` | Real configuration or code paths exist in this repository. |
| `tested` | CI or a script verifies it, and that verification **can fail**. |
| `productionProven` | Real production traffic has run through it. |

## Find documentation by task

| What you want to do | Route |
| --- | --- |
| First deployment, get the first bot running | [Choose an architecture](getting-started/choose-architecture.md) → [Quickstart](getting-started/quickstart.md) → [Docker Compose](platforms/docker.md) |
| You have one VPS | [`single-host`](architectures/single-host.md) → [Docker Compose](platforms/docker.md) or [VPS and bare metal](platforms/vps.md) |
| Run production on Fly.io | [`split-worker`](architectures/split-worker.md) → [Fly.io](platforms/flyio.md) → [Cloudflare clock](platforms/cloudflare.md) |
| You have two machines (VPS + home server) | [`remote-worker`](architectures/remote-worker.md) → [VPS and bare metal](platforms/vps.md) |
| No public ingress | [Docker Compose](platforms/docker.md), polling mode |
| A domain and public HTTPS ingress | [Docker Compose](platforms/docker.md), webhook mode |
| Mainland-China server that needs a proxy | [Proxy and egress](platforms/proxy.md) |
| Add a 2nd, 3rd channel | [Multi-bot (中文)](/operations/multi-bot.md) |
| Not enough memory / OOM tuning | [Performance and memory (中文)](/operations/performance.md) |
| Something is not working | [Troubleshooting (中文)](/operations/troubleshooting.md) → [Monitoring (中文)](/operations/monitoring.md) |
| Backup or restore | [Backup (中文)](/operations/backup.md) → [Persistent state (中文)](/concepts/state.md) |
| Upgrade or roll back | [Upgrades (中文)](/operations/upgrades.md) |
| Move to another architecture | [Migration contract (中文)](/architectures/migration.md) |
| Scheduling, slots, idempotency | [Scheduling (中文)](/concepts/scheduling.md) → [Delivery (中文)](/concepts/delivery.md) |
| Who may sleep, who wakes whom | [Lifecycle (中文)](/concepts/lifecycle.md) |
| Where credentials live, where the boundary is | [Credentials (中文)](/concepts/credentials.md) |
| The authority for each concept | [Deployment contract](reference/deployment-contract.md) |
| Download the `deploy` binary | [Download](download.md) |
| The multi-architecture implementation plan | [Roadmap (中文)](/ROADMAP-MULTI-ARCH.md) |

## Read-only verification

Never prints secrets; prints `SKIP` instead of failing when a variable is absent.

```bash
./scripts/verify-production.sh    # three planes, lifecycle flags, trigger auth, webhook ownership
./scripts/smoke-telepost.sh       # probes + submission API auth
./scripts/smoke-pixivflow.sh      # stopped state + unauthorized trigger rejected
./scripts/verify-webhooks.sh      # who owns the bots' webhooks (needs BOT*_TOKEN)
./scripts/verify-images.sh        # deployed image/commit vs the pinned expectation
```

Details: [monitoring (中文)](/operations/monitoring.md).

## Other entry points

- Repository: <https://github.com/redtidev1918/pixivflow-telepost-deploy>
- Releases: <https://github.com/redtidev1918/pixivflow-telepost-deploy/releases>
- Issues: <https://github.com/redtidev1918/pixivflow-telepost-deploy/issues>
