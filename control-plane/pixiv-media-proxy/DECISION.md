# ADR: allowlist-driven Pixiv-first media proxy

## Status

VERIFIED (Worker route + deploy; full real-novel rich-novel E2E remains EXTERNAL_ACCEPTANCE_REQUIRED)

## Context

Rich-novel previews need inline images. Catbox / Telegra.ph external image hosts
are the current fallback but are a hard dependency and have egress issues
(`412 Invalid uploader`, `400 Unknown error`).

TelePress already exposes the generic configuration
(`TELEPRESS_MEDIA_PROXY_BASE`, `TELEPRESS_MEDIA_PROXY_HOSTS`), but the deployed
Worker only accepted the legacy `/pixiv/` route.

## Community Research

Investigated existing patterns:

- Pixiv.Cat / community `pximg` proxies for the fixed `i.pximg.net` + Referer
  pattern.
- Cloudflare Workers cache-proxy guidance for fixed public media origins.
- Signed-URL / host-allowlist media proxies as the safer generalization of
  arbitrary URL proxies.

Decision: keep the small Worker and extend it to the allowlist route already
understood by TelePress. We do not adopt an external proxy service for this
single narrow capability or accept arbitrary `url=` parameters.

## Decision

The Worker supports two fixed forms:

```text
/pixiv/<path>            -> https://i.pximg.net/<path>
/media/<host>/<path>     -> https://<host>/<path> (exact allowlist)
```

The generic route is **not** an open proxy. `MEDIA_PROXY_ALLOWED_HOSTS` is the
only source-host authority, and every request remains GET/HEAD, image-only,
redirect-free, cookie-free, and path-traversal-safe.

## Integration

TelePress uses:

```env
TELEPRESS_MEDIA_PROXY_BASE=https://<worker>
TELEPRESS_MEDIA_PROXY_HOSTS=i.pximg.net
```

The legacy `TELEPRESS_PIXIV_PROXY_BASE` remains supported by TelePress, but the
production Fly config uses the generic variables.

## Fallback

If the proxy or a source host is unavailable, TelePress falls back to the
existing image-host upload path.
