# pixiv-media-proxy

Cloudflare Worker that proxies Pixiv CDN images (`i.pximg.net`) for generated
rich-novel previews, so TelePress can render inline images without Persisting
Pixiv's Referer requirement to clients or depending on external image hosts as
a hard requirement.

## Route

```text
https://<worker>/pixiv/<path>   ->   https://i.pximg.net/<path>
```

- Only `GET` / `HEAD`.
- Only `https://i.pximg.net` is ever reached (path stuck under `/pixiv/`).
- Fixed `Referer: https://www.pixiv.net/` is injected by this Worker.
- Successful responses are edge-cached (`cf.cacheEverything`, TTL 86400s).
- `/health` returns `{"ok": true, "service": "pixiv-media-proxy"}`.

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

Then set `TELEPRESS_PIXIV_PROXY_BASE=https://<worker>` on the TelePress host.
