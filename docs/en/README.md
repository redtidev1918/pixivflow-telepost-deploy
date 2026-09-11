# PixivFlow + TelePost Deploy — Documentation

**Language / 语言:** [中文](/) · English

> This is the deployment kit that wires [PixivFlow](https://github.com/redtidev1918/PixivFlow)
> (download scheduler) together with [TelePost](https://github.com/redtidev1918/TelePost)
> (Telegram review/publish bot), shipped as a Go `deploy` CLI plus Docker Compose and
> Fly.io backends.

## Production design and operations

These two pages are the authoritative English references for the serverless control plane
that currently runs in production (Cloudflare Worker + D1).

| Document | Content |
| :-- | :-- |
| [Architecture and invariants](SERVERLESS-ARCHITECTURE.md) | Worker + D1 as the single clock and ledger; why each legacy failure mode is now structurally impossible |
| [Deployment and operations](SERVERLESS-OPERATIONS.md) | Deployment, migration, credentials, execution-plane contract, observability and runbooks |
| [Cutover handbook (中文)](/SERVERLESS-CUTOVER.md) | Ordered cutover steps, rollback, acceptance criteria and Fly retirement |

## Downloads

| Document | Content |
| :-- | :-- |
| [📥 Download](download.md) | Per-platform `deploy-<os>-<arch>` tarballs and checksums, auto-generated on every release |

## Chinese guides (English index)

The deployment scenarios, proxy setup and tuning guides are currently written in Chinese.
Start from the [documentation home](/), or jump directly to:

| Document | Content |
| :-- | :-- |
| [SCENARIOS](SCENARIOS.md) | Two paths (Compose / deploy CLI), four Compose scenarios, systemd backend, Fly.io |
| [POLLING](POLLING.md) | No public ingress: `RUN_MODE=AUTO`, empty `WEBHOOK_URL` |
| [WEBHOOK](WEBHOOK.md) | Public HTTPS: Caddy certificates, multi-bot paths, reverse proxy |
| [MIHOMO](MIHOMO.md) | Proxy container, proxy environment variables, build-time proxy |
| [MULTI-BOT (中文)](/MULTI-BOT.md) | Auto-discovering `BOT{N}_TOKEN`, adding bots, routing PixivFlow deliveries |
| [SCHEDULING (中文)](/SCHEDULING.md) | Single source of truth for scheduled posting, slot idempotency and shutdown |
| [PERFORMANCE (中文)](/PERFORMANCE.md) | Measuring first, then tuning levers; 256/512/1 GiB tiers |
| [ARCHITECTURE (中文)](/ARCHITECTURE.md) | Core runtime vs. platform optimizations, process model, trust boundaries |

## Links

- Repository: <https://github.com/redtidev1918/pixivflow-telepost-deploy>
- Releases: <https://github.com/redtidev1918/pixivflow-telepost-deploy/releases>
