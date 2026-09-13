# Proxy (bundled Mihomo / external proxy)

> **This page is the authoritative description of how a mainland network obtains egress for
> Pixiv/Telegram.** It replaces the old `MIHOMO.md`. The principles of egress and transport are in
> the [network.md (中文)](/concepts/network.md).

## First: do you actually need a proxy?

You do not need a proxy when you can reach Pixiv's three data planes directly
(`oauth.secure.pixiv.net`, `app-api.pixiv.net`, `i.pximg.net`). **Being able to authenticate is not
the same as having a qualified egress**: repeated rate limiting is an egress-qualification problem,
and a proxy only solves reachability and egress choice.

## Two approaches

Prefer a stable, compliant proxy you already have; this repository only provides an optional
runtime container — no nodes and no subscriptions.

| Approach | When it applies | Configuration |
| --- | --- | --- |
| External proxy (recommended) | you already have a stable, compliant proxy | set `HTTP_PROXY_URL` and `EGRESS_ALL_PROXY` |
| Bundled Mihomo | you want to use a subscription | `SUB_URL` + `--profile proxy` |

### External proxy

```dotenv
HTTP_PROXY_URL=http://your-proxy:8080
EGRESS_ALL_PROXY=http://your-proxy:8080
```

### Bundled Mihomo

```dotenv
SUB_URL=https://your-subscription-url
HTTP_PROXY_URL=http://proxy:7890
EGRESS_ALL_PROXY=http://proxy:7890
```

```bash
docker compose --profile proxy up -d
```

The `proxy` service builds the `./proxy` image; ports 7890 (mixed) / 9090 (control) bind **only to
the host loopback**; the config volume is `./proxy-data` and `mem_limit` defaults to `128m`
(`PROXY_MEMORY_LIMIT`).

## The memory reality

Mihomo takes **50–100 MiB**. On a machine with only 512 MiB:

- **prefer an external proxy**, or move up to 1 GiB;
- the matrix lists `bundled-proxy-on-256m` as `invalid`: the proxy alone needs 50–100 MiB.
- A Mihomo with a large rule set running alongside the executor processes will fight them for
  memory, showing up as proxy OOM / download timeouts / failed Telegram requests — switch to an
  external proxy or add memory, and do **not** delete cache/outbox entries to buy a lower-looking
  footprint.

## NO_PROXY is not optional

Compose already sets `NO_PROXY` / `no_proxy` to include
`127.0.0.1,localhost,telepost,pixivflow,proxy`. Remove them and the executor's internal delivery to
the service side goes over the public internet or through the proxy, and delivery fails. See
[delivery.md (中文)](/concepts/delivery.md).

## Build-time proxy

When building images locally on a mainland machine, point `BUILD_HTTP_PROXY` / `BUILD_HTTPS_PROXY`
at a proxy the host can reach. **A running Compose proxy does not take part in the build** —
alternatively build and push the image from a machine with connectivity or from CI, then just run
`docker compose pull`.

## Related pages

- Network and egress: [network.md (中文)](/concepts/network.md)
- Docker deployment: [docker.md](./docker.md)
- Egress rate limit incident: [incident record (中文)](/incidents/2026-09-11-pixiv-egress-rate-limit.md)
