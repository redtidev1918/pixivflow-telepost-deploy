# ADR: fixed-upstream Pixiv media proxy

## Context

Rich-novel previews need inline images. Catbox / Telegra.ph external image hosts
are the current fallback but are a hard dependency and have egress issues
(`412 Invalid uploader`, `400 Unknown error`).

## Decision

Add a Cloudflare Worker that proxies ONLY `https://i.pximg.net` under
`/pixiv/<path>`. TelePress rewrites Pixiv CDN source URLs in a rich-novel
`manifest` to this proxy when `TELEPRESS_PIXIV_PROXY_BASE` is set. No Manifest
entry that isn't an `i.pximg.net` URL is ever proxied, so this is not an open
proxy or SSRF surface. The Worker needs no database/KV/R2; edge cache is enough
for a fixed public image origin.

## Status

IMPLEMENTED (deploy + acceptance required).
