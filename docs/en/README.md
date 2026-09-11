# PixivFlow + TelePost Deploy — Documentation

Language / 语言: [中文](/) · English

This is the deployment kit that wires [PixivFlow](https://github.com/redtidev1918/PixivFlow)
(download scheduler) together with [TelePost](https://github.com/redtidev1918/TelePost)
(Telegram review/publish bot), shipped as a Go `deploy` CLI plus Docker Compose and Fly.io backends.

## Production design and operations

The single authoritative description of the production topology is
[架构与信任边界 / Architecture and trust boundaries](/ARCHITECTURE.md) (Chinese): Cloudflare only
decides *when* to wake, PixivFlow only decides *what* to execute and how to deliver it, and
TelePost is the only always-on service and the only holder of Telegram credentials. Read that
document before changing anything in this repository.

Read-only verification (never prints secrets):

```bash
./scripts/verify-production.sh    # three planes, lifecycle flags, trigger auth, webhook ownership
./scripts/smoke-telepost.sh       # probes + submission API auth
./scripts/smoke-pixivflow.sh      # stopped state + unauthorized trigger rejected
./scripts/verify-webhooks.sh      # who owns the two bots' webhooks (needs BOT*_TOKEN)
./scripts/verify-images.sh        # deployed image/commit vs the pinned expectation
```

## Downloads

| Document | Content |
| :-- | :-- |
| [Download](download.md) | Per-platform `deploy-<os>-<arch>` tarballs and checksums, auto-generated on every release |

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
| [REMOTE_UPDATES (中文)](/REMOTE_UPDATES.md) | Source hotfix, config updates, TelePost policy short restart from a Mac |
| [SCHEDULING (中文)](/SCHEDULING.md) | Single source of truth for scheduled posting, slot idempotency and shutdown |
| [PERFORMANCE (中文)](/PERFORMANCE.md) | Measuring first, then tuning levers; 256/512/1 GiB tiers |
| [ARCHITECTURE (中文)](/ARCHITECTURE.md) | The sole authority for the three-plane contract, lifecycle, persistence and trust boundaries |

## Links

- Repository: <https://github.com/redtidev1918/pixivflow-telepost-deploy>
- Releases: <https://github.com/redtidev1918/pixivflow-telepost-deploy/releases>
