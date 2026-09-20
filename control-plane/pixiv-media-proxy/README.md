# pixiv-media-proxy

Cloudflare Worker that proxies CDN media through a fixed-host allowlist. It is
used by TelePress to render rich-novel preview images without depending on an
external image host as a hard requirement.

## Routes

```text
/pixiv/<path>                         -> https://i.pximg.net/<path>
/media/<host>/<path>                  -> https://<host>/<path> (if allowlisted)
```

`/pixiv/...` remains as the legacy route. New TelePress deployments should use
the generic route:

```env
TELEPRESS_MEDIA_PROXY_BASE=https://<worker>
TELEPRESS_MEDIA_PROXY_HOSTS=i.pximg.net
```

## Security invariants

- Only `GET` / `HEAD`.
- The generic route only reaches hosts named in
  `MEDIA_PROXY_ALLOWED_HOSTS`; there is no `?url=` or arbitrary-origin mode.
- Host matching is exact and accepts DNS hostnames only: no ports, wildcards,
  schemes, paths, or lookalike suffixes.
- Path traversal (`..`, `//`, encoded separators) is rejected.
- Upstream redirects are rejected, so a fixed origin cannot bounce to another
  domain.
- Client cookies, authorization, and arbitrary headers are never forwarded.
- `i.pximg.net` gets a fixed `Referer: https://www.pixiv.net/`; clients cannot
  supply credentials.
- Upstream responses must be `image/*`; non-images return 502 and 404 remains
  404.
- Only a small response-header allowlist is returned; `Set-Cookie` and other
  upstream headers are dropped.
- Successful image responses are edge-cached for one day.
- `/health` returns `{"ok": true, "service": "pixiv-media-proxy"}`.

For a public deployment, enable Cloudflare WAF rate limiting in front of the
Worker. The Worker itself intentionally has no database, KV, or R2 binding.

## Local test

```bash
cd control-plane
npm test -- pixiv-media-proxy
```

## Deploy

```bash
cd control-plane/pixiv-media-proxy
npx wrangler deploy
```

Then set the generic TelePress variables on the TelePress host as shown above.
