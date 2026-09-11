# Deployment scenarios cheat sheet

**Language / 语言:** [中文](/SCENARIOS.md) · English

Two paths, pick one:

- **Docker Compose (recommended, for a local machine, an overseas VPS or a mainland-China VPS)**:
  initialise with `deploy init` (zero-setup, one binary is enough) or with the in-repo
  `./scripts/bootstrap.sh`, then fill in `.env` for your scenario.
- **The `deploy` tool (single Go binary)**: one entry point for Docker / Fly.io / a Linux VPS
  without Docker (systemd backend), auto-detected or given explicitly with `--platform`.

## Docker Compose scenarios

| Scenario | Key `.env` entries | Start command |
|---|---|---|
| Home / NAT / no public ingress | `RUN_MODE=AUTO`, `WEBHOOK_URL=` (default) | `docker compose up -d` |
| Overseas VPS + domain | set `WEBHOOK_DOMAIN`, `WEBHOOK_URL` | `docker compose --profile webhook up -d` |
| Mainland server + external proxy | set `HTTP_PROXY_URL`, `EGRESS_ALL_PROXY` | `docker compose up -d` |
| Mainland server + bundled Mihomo | also set `SUB_URL` | `docker compose --profile proxy up -d` |

The `deploy init` wizard asks about the scenarios above (Enter keeps Polling) and writes the
matching `.env` plus the suggested commands. `init` needs only Docker and the one binary — no
repository clone, no bash or python.

## Linux VPS without Docker (systemd backend)

All you need is a Linux machine with systemd (TelePost is Python and PixivFlow is Node;
running both on one machine is the cheapest combination):

```bash
sudo ./deploy doctor --platform systemd        # self-check (systemctl/python3/git + write permissions)
sudo ./deploy deploy --platform systemd        # first run: clones /opt/telepost + venv/pip + npm i -g pixivflow + prompts for BOT1_TOKEN/BOT1_CHANNEL_ID → installs telepost.service
./deploy status --platform systemd             # systemctl status + health
./deploy logs 100 --platform systemd           # recent journalctl logs
sudo ./deploy tp latest --platform systemd     # upgrade TelePost (git pull + pip + restart)
sudo ./deploy pf latest --platform systemd     # upgrade PixivFlow (npm reinstall + restart)
```

Notes: writing to `/opt` and `/etc/systemd` needs root (non-root invocations `sudo`
automatically); the first deployment also installs `python3-venv` if needed, and enabling
PixivFlow requires Node 22+.

## Fly.io

```bash
./deploy init <dir>            # writes telesubmit.fly.toml (service) and pixivflow.fly.toml (worker)
./deploy doctor --platform fly        # checks flyctl login and friends
./deploy deploy --platform fly        # or ./deploy tp latest --platform fly
```

Platform auto-detection order (`--platform auto`): `telesubmit.fly.toml` present and flyctl
logged in → Fly.io; a `docker-compose.yml` in the directory → Compose; `systemctl` on Linux →
systemd. Having a public address does not force Webhook; when you cannot reliably provide
inbound HTTPS, Polling is simpler and more reliable.

> Fly is **always-on** by default. To save money you can enable auto-stop, or split into two
> Production topology and lifecycle: see [ARCHITECTURE.md](ARCHITECTURE.md).

## Want the WebUI management panel?

The kit's combined image does not include WebUI by default (the 512 MiB trade-off). On a ≥1 GiB
machine you can run the official webui container sharing `./data` with the kit (zero changes to
the kit). Build commands, shared-volume startup and concurrency caveats are in the
[README section "Optional: PixivFlow WebUI management panel"](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/README.en.md).

> Pages marked **（中文）** are currently Chinese-only. Their English versions are being added
> incrementally.
