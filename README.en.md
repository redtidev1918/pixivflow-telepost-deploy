# PixivFlow + TelePost Deploy

**Language / 语言:** [中文](README.md) · English

[![Validate](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/validate.yml)
[![Release](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml/badge.svg)](https://github.com/redtidev1918/pixivflow-telepost-deploy/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/Docs-documentation_site-6366f1?style=flat-square)](https://redtidev1918.github.io/pixivflow-telepost-deploy/)

A deployment kit for running Pixiv auto-posting for real: PixivFlow scrapes works by
topic or ranking, TelePost handles review and channel publishing. One config covers an
overseas VPS, a mainland-China server, a NAT-only host without public ingress, a local
macOS/Linux machine, and Fly.io. The default (Compose) topology runs two independent
containers — a TelePost multi-bot supervisor and a PixivFlow scheduler — each pulling a
`ghcr` image and talking over HTTP, sized for 512 MiB machines with no WebUI. Fly.io can
optionally use a combined image.

## Production architecture (current)

Production runs a **serverless control plane**: a Cloudflare Worker plus D1 as the only
state store and the only clock, GitHub Actions as a one-shot execution plane, and
Telegram providing durable media and human review.

```
Cloudflare Worker + D1  (cron */10 = the only clock; ledger, admission, review state)
        │  workflow_dispatch
        ▼
GitHub Actions          (one-shot runner: one occurrence, destroyed when done)
        │  HTTPS claim / result
        ▼
Telegram                (media uploaded once; publishing is a server-side copyMessage)
```

**Why the change**: machine sleep, HTTP relay timeouts, long-lived scheduler processes,
leases left behind by crashes, one missed cron losing a whole day, two clocks causing
duplicate posts — these are **structural** problems that no amount of retrying fixes. The
new architecture makes each class **impossible by construction** instead of "handled better".

- Architecture and invariants (English): **[docs/en/SERVERLESS-ARCHITECTURE.md](docs/en/SERVERLESS-ARCHITECTURE.md)**
- Deployment, migration, credentials, execution-plane contract, observability, runbooks (English): **[docs/en/SERVERLESS-OPERATIONS.md](docs/en/SERVERLESS-OPERATIONS.md)**
- Cutover steps, rollback, acceptance criteria, Fly retirement (Chinese): **[docs/SERVERLESS-CUTOVER.md](docs/SERVERLESS-CUTOVER.md)**

> The Fly / Compose / systemd options below are the **legacy always-on architecture**,
> kept as a rollback target and for local/self-hosted use. Production no longer uses them.
> See [docs/SERVERLESS-CUTOVER.md](docs/SERVERLESS-CUTOVER.md) §8.

> ⚠️ **A retired Fly app must not be able to join production**: `autostart=false`, and no
> watchdog may wake it. Otherwise it competes for the same Pixiv credentials and steals the
> Telegram webhook on boot. Rollback is an **explicit two-step** operation:
> `machine start` plus an operator `setWebhook`.

## Which deployment should I choose? (legacy always-on)

- **Not using Fly**: with Docker use **Docker Compose**; without Docker use **systemd / bare
  metal**. Both use an internal cron scheduler with a long-running process.
- **Using Fly**:
  - **Low traffic, cost-sensitive, cold start of a few seconds is fine** → **Fly Autosleep**:
    1×512 MB, normally fully stopped; a Telegram webhook or an external clock (Cloudflare
    Cron) sends an authenticated Slot HTTP request at 10:00/18:00 to wake it. See
    [docs/SCHEDULING.md](docs/SCHEDULING.md), `fly/deploy.fly-autosleep.toml`,
    `scheduler/cloudflare/`.
  - **Want the least maintenance and can pay a few dollars a month** → **Fly Always-on**:
    1×512 MB always on, internal cron, no external dependency.
  - **Need service isolation / 512 MB measured insufficient** → **Fly Split**: PixivFlow
    256 MB always on + TelePost 512 MB with autosleep.

> The single source of truth for scheduled posting, shutdown, slot idempotency and
> no-duplicate retries: **[docs/SCHEDULING.md](docs/SCHEDULING.md)** (Chinese).
> The historical Fly autosleep design and its cold-start cost:
> [docs/AUTOSTOP.md](docs/AUTOSTOP.md) (Chinese).

## Features

- **Topic-driven auto-posting**: scrapes "yesterday's most popular" works by Pixiv topic
  (tag-space inference) or daily ranking, takes Top N illustrations and novels, and
  excludes AI-generated works using Pixiv's official `illust_ai_type` flag.
- **Chinese-novel filtering**: `franc-min` language detection plus `strictLanguageFilter`
  so only Chinese novels are posted.
- **Review group with reply chains**: API submissions land in a review group first;
  multi-page galleries are packed into Telegram albums of ≤10 with albums replying to each
  other. Approved posts reuse the Telegram `file_id`, so media is never uploaded twice.
- **Full caption templating**: title, note, tags, original link and spoiler policy are all
  templated; NSFW inclusion and the Telegram spoiler mask are independent, so an R-18 tag
  does not mask anything by default. Tags are sanitised into clickable hashtags
  (`r-18 → #r18`).
- **Multiple network modes**: Polling / Webhook / optional Mihomo proxy, all exposing the
  same `api/botN/v1/*` interface.
- **Low-memory friendly**: runs in 512 MiB — small albums with automatic per-image fallback,
  per-page forced GC and tunable health-check parameters.
- **Remote hot updates**: PixivFlow atomically hot-reloads its config; a TelePost OWNER can
  persist policy for the current bot via `/botconfig`, while bulk policy changes still apply
  through a scripted short restart.
- **Never silent, never duplicate**: an empty final candidate list still posts to the review
  group; PixivFlow's persistent outbox prevents lost notifications during short outages and
  TelePost's SQLite idempotency records prevent duplicate notifications after restarts.

## Network modes

| Machine | How to start | TelePost mode |
|---|---|---|
| No public ingress; Telegram/Pixiv reachable | `docker compose up -d` | AUTO picks Polling |
| Domain with inbound 80/443 | `docker compose --profile webhook up -d` | AUTO picks Webhook |
| Mainland China, proxy required | `docker compose --profile proxy up -d` | Polling + Mihomo |
| Fly.io | `deploy` (recommended, below) or `fly deploy -c fly/deploy.fly-multi-bot.toml` | Webhook |
| Linux VPS (systemd, no Docker) | `deploy --platform systemd` | Polling (runs from source) |

Both Polling and Webhook expose the same `http://127.0.0.1:8080/api/botN/v1/*`, so
PixivFlow's delivery config does not change with the network mode. If webhook registration
fails, AUTO falls back to Polling.

## The `deploy` CLI

A single Go binary for Windows / macOS / Linux with zero runtime dependencies (no Python,
no shell scripts, no venv, no pip) and no need to clone this repository.

### One-shot deployment on a fresh machine

Install only **Docker** plus this one binary; three commands get you running:

```bash
deploy init mybot        # 1) scaffold a deployment directory (embedded compose/.env/templates, guided Bot setup)
cd mybot
deploy doctor && deploy deploy   # 2) self-check -> 3) deploy (docker compose pull/up + health check)
```

`init` generates a Polling-mode `.env` and a two-bot example config, then asks which
scenario you want: **Webhook** (with a domain; fills `WEBHOOK_*` and suggests
`--profile webhook`), **China + Mihomo proxy** (fills proxy/subscription values and suggests
`--profile proxy`), or **Fly.io** (generates `telesubmit.fly.toml` and suggests secrets plus
`--platform fly`). Pressing Enter keeps Polling. In non-interactive mode (pipe/CI) it stays
silent and only writes placeholder config.

### Getting it

Option 1: download `deploy-<os>-<arch>` (linux/darwin/windows × amd64/arm64) from
[Releases](https://github.com/redtidev1918/pixivflow-telepost-deploy/releases), extract,
rename to `deploy`, and `chmod +x` on Linux/macOS.

Option 2: build from source (requires Go 1.22+):

```bash
go build -o deploy .
```

### Usage

```bash
./deploy init <dir>             # fresh deployment: scaffold a directory and fill in bot details
./deploy doctor                 # environment self-check (dependencies/config/login/network)
./deploy tp latest              # upgrade TelePost to latest and deploy (or pin e.g. 2.10.41)
./deploy pf 2.10.31             # upgrade PixivFlow to a specific version (ugoira->GIF needs >=2.10.31)
./deploy --platform fly --config fly/pixivflow-split.toml source ../PixivFlow
./deploy status                 # status / health
./deploy logs 200               # last 200 log lines
./deploy version                # tool and current config version
```

Platform auto-detection (default `--platform auto`): `telesubmit.fly.toml` present and
flyctl logged in → Fly.io; otherwise `docker-compose.yml` → Docker Compose; otherwise
`systemctl` on Linux → systemd. You can also pass `--platform fly|compose|systemd`.

Common options: `--dry-run` (preview only, change nothing), `--verbose` (echo full command
output), `--retries N` (retry failed deployments), `--no-color`. Every run writes a full log
to `/tmp/deploy-logs/` (`%TEMP%` on Windows) and prints the path on failure.

## Quick start (Docker Compose)

Requires Docker 24+ and Compose v2. `bootstrap.sh` / `validate.sh` additionally need bash and
python3 for local generation and validation only.

```bash
git clone https://github.com/redtidev1918/pixivflow-telepost-deploy
cd pixivflow-telepost-deploy
./scripts/bootstrap.sh
```

Edit `.env` and fill in at least `BOT1_TOKEN`, `BOT1_CHANNEL_ID` and `BOT1_OWNER_ID`. To
enable PixivFlow also fill in `PIXIV_REFRESH_TOKEN` and the `TELEPOST_BOT1_SUBMIT_TOKEN`
generated by the bot's `/gen_token`. Then edit `data/pixivflow/config.json` (based on
`pixivflow/config/fly-two-bots.example.json`), replacing the sample topics with your tags,
adjusting the cron, and flipping the plans you want to `"enabled": true`.

```bash
./scripts/validate.sh
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/health
```

Prebuilt images are pulled from GHCR (public): `TELEPOST_IMAGE` and `PIXIVFLOW_IMAGE` are
built by their own repositories, so no local image build is needed here (except
Caddy/Mihomo under `--profile webhook/proxy`). Pin both variables to explicit release tags
in production; `latest` is fine for a first look but upgrades on the next pull.

## Memory tiers

Compose decouples `telepost` and `pixivflow` into **two containers**, with `mem_limit`
defaults sized for a 512 MiB machine: **telepost 320m + pixivflow 192m** (tunable via
`TELEPOST_MEMORY_LIMIT` / `PIXIVFLOW_MEMORY_LIMIT`).

| Tier | Combination | How |
|---|---|---|
| **256 MiB** | Single bot, no PixivFlow | Start only telepost: `docker compose up -d telepost` with `TELEPOST_MEMORY_LIMIT=256m` |
| **512 MiB** (default) | Two bots + PixivFlow | Defaults: telepost 320m + pixivflow 192m |
| **≥1 GiB** | The above with headroom / WebUI | Raise `TELEPOST_MEMORY_LIMIT=512m`, `PIXIVFLOW_MEMORY_LIMIT=384m` |

The optional PixivFlow WebUI needs ≥1 GiB. Before exposing it publicly, set both
`WEBUI_USERNAME` and `WEBUI_PASSWORD` (Basic Auth is enabled only when both are non-empty).

## Security boundaries

- `.env`, `data/`, `proxy-data/` and upload temp files are gitignored.
- Bot tokens, Pixiv refresh tokens, submit tokens and proxy subscription URLs belong only in
  `.env` or platform secrets — never in JSON templates, git history or chat screenshots.
- The root API binds to `127.0.0.1` by default; Webhook goes through a Caddy reverse proxy.
- Before changing channels, process pending submissions in the old review group and confirm
  the bot is an administrator of the new channel.

Public-repository CI checks for common token formats and untracked runtime paths, and the
Docker build context excludes local secrets and data via `.dockerignore`. Automated checks
are not a substitute for rotation: if a credential ever reached an issue, log, screenshot or
git history, revoke it immediately.

## Documentation

Full documentation site: <https://redtidev1918.github.io/pixivflow-telepost-deploy/>

| Document | Content |
| :-- | :-- |
| [📥 Download](docs/download.md) | Per-platform `deploy` binaries (auto-updated on every release) |
| [English docs index](docs/en/README.md) | English entry point, including the production serverless design and ops pages |
| [SCENARIOS](docs/SCENARIOS.md) | Deployment scenario cheat sheet (Chinese) |
| [SCHEDULING](docs/SCHEDULING.md) | Scheduled posting, shutdown, slot idempotency (Chinese) |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Architecture and trust boundaries (Chinese) |

## Contributing

- Architecture and component boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Adding the Nth channel (multi-bot): [docs/MULTI-BOT.md](docs/MULTI-BOT.md)
- Contributing code: [CONTRIBUTING.md](CONTRIBUTING.md)
- Usage and troubleshooting: [SUPPORT.md](SUPPORT.md)
- Reporting vulnerabilities privately: [SECURITY.md](SECURITY.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

Upstream projects: [PixivFlow](https://github.com/redtidev1918/PixivFlow) ·
[TelePost](https://github.com/redtidev1918/TelePost)

## License

[MIT](LICENSE)

This project is not affiliated with Pixiv, Telegram or Fly.io. Deployers should only handle
content they have the right to download, store and publish, and must comply with platform
terms, copyright requirements and local law.
