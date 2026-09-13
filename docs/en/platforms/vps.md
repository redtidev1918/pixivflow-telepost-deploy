# VPS / bare metal (systemd or Docker)

> **This page is the authoritative description of deploying on a VPS or bare metal without Fly,
> and not necessarily with Docker.** A single VPS using Compose follows [docker.md](./docker.md)
> (that is [`single-host`](../architectures/single-host.md)); running from source under systemd is
> the same `single-host` semantics with a different runtime. Two machines:
> [remote-worker.md](../architectures/remote-worker.md).

## Two routes

| Route | Prerequisite | Command | Notes |
| --- | --- | --- | --- |
| Docker Compose | Docker 24+ | `docker compose up -d` | recommended, see [docker.md](./docker.md) |
| systemd (no Docker) | Linux + systemd + python3/node | `./deploy --platform systemd` | runs from source; `deploy` installs the dependencies |

## What the systemd route does

`deploy --platform systemd` will:

1. clone TelePost → create a venv + `pip install`;
2. install Node + `npm i -g pixivflow` (**the money-saving combined single-machine shape**: two
   processes hosted on one machine);
3. prompt for `BOT1_TOKEN` / `BOT1_CHANNEL_ID` and whether to enable PixivFlow, then write
   `/opt/telepost/.env`;
4. write `/etc/systemd/system/telepost.service`;
5. `systemctl enable --now telepost`.

TelePost's supervisor hosts the bot and PixivFlow as two processes on the same machine, reproducing
the money-saving combination used on Fly. Upgrades: `./deploy tp latest` (git pull + pip + restart),
`./deploy pf latest` (npm reinstall + restart).

On bare metal `watchConfig = true` (same as Compose): editing `data/pixivflow/config.json`
hot-reloads it.

## 512 MiB VPS notes

- At most two bots; search and the WebUI off.
- `download.concurrency=1`.
- The bundled proxy does not fit (50–100 MiB): prefer an external proxy, otherwise move up to
  1 GiB. See [network.md (中文)](/concepts/network.md) and [proxy.md](./proxy.md).

## Egress qualification (the most common trap)

**Being able to log in is not the same as having a qualified egress.** Repeated
`rate limit cooldown` with `penaltyLevel` climbing from 1 to 2 is an egress-qualification problem.
A mainland VPS running Pixiv usually needs a qualified egress: add a proxy, or put the executor on
an overseas node ([remote-worker.md](../architectures/remote-worker.md)). Evidence and timeline:
[incident record (中文)](/incidents/2026-09-11-pixiv-egress-rate-limit.md).

## Building images locally on a mainland machine

If you must build locally, set `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY` in `.env` to a proxy
address the host can reach (a running Compose proxy **cannot** take part in the build).

## Related pages

- Single-host preset: [single-host.md](../architectures/single-host.md)
- Docker route: [docker.md](./docker.md)
- Network and egress: [network.md (中文)](/concepts/network.md)
- Environment variables: [environment.md (中文)](/reference/environment.md)
