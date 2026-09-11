# Mainland China networking and Mihomo

**Language / 语言:** [中文](/MIHOMO.md) · English

Prefer a stable, compliant proxy you already have; this repository only provides an optional
runtime container — no nodes and no subscriptions.

Bundled Mihomo configuration:

```dotenv
SUB_URL=https://example.invalid/subscription
HTTP_PROXY_URL=http://proxy:7890
EGRESS_ALL_PROXY=http://proxy:7890
```

```bash
docker compose --profile proxy up -d
docker compose logs -f proxy stack
```

Ports 7890 and 9090 bind only to the host loopback address. `NO_PROXY` already includes
`127.0.0.1`, `stack` and `proxy`, so PixivFlow's submissions to TelePost never traverse the
public internet or the proxy.

When building images locally for the first time on a mainland machine, the running Compose
proxy cannot take part in the build. Start Mihomo first and point `BUILD_HTTP_PROXY` /
`BUILD_HTTPS_PROXY` in `.env` at a proxy address the host can reach; alternatively build and
push the image from a machine with connectivity or from CI, then simply run
`docker compose pull`.

Running Mihomo with a large rule set is not recommended on a 512 MiB machine. If the proxy
frequently OOMs, or Pixiv downloads time out, or Telegram requests fail, switch to an external
proxy or move up to 1 GiB.
