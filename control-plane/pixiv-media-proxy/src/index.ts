/**
 * Pixiv media proxy Worker.
 *
 * Fixed-upstream image proxy for `https://i.pximg.net`. It is NOT an open
 * proxy: only `/pixiv/<path>` maps to a path under `i.pximg.net`, only
 * GET/HEAD are allowed, and Pixiv's Referer is injected by this Worker so
 * clients never need (or can set) credentials for Pixiv CDN. `TELEPRESS_*`
 * does not appear here; TelePress points its `TELEPRESS_PIXIV_PROXY_BASE` at
 * this Worker's public base URL.
 */
const UPSTREAM_BASE = 'https://i.pximg.net';
const PIXIV_REFERER = 'https://www.pixiv.net/';
const PROXY_PREFIX = '/pixiv/';

export interface Env {
  /** Test/development override of the global fetch. */
  PIXIV_PROXY_FETCH?: typeof fetch;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'pixiv-media-proxy' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    if (!url.pathname.startsWith(PROXY_PREFIX)) {
      return json({ error: 'not_found' }, 404);
    }

    const suffix = url.pathname.slice(PROXY_PREFIX.length);
    if (!suffix || suffix.startsWith('..') || suffix.includes('//') || suffix.split('/').includes('..')) {
      return json({ error: 'invalid_path' }, 400);
    }

    const target = `${UPSTREAM_BASE}/${suffix}${url.search}`;
    // Client-supplied Referer/OAuth/cookies are irrelevant for a fixed public
    // image upstream; force our own Referer and drop session-bearing headers.
    // Only forward a minimal set of client headers; never relay cookie /
    // authorization / arbitrary client headers to Pixiv's CDN.
    const headers = new Headers();
    headers.set('Referer', PIXIV_REFERER);
    for (const name of ['Accept', 'Accept-Encoding', 'Range', 'If-Range', 'If-Modified-Since', 'If-None-Match']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const fetchImpl: typeof fetch = env.PIXIV_PROXY_FETCH ?? fetch;
    const upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    if (upstream.status >= 400) {
      return json({ error: 'upstream_error', status: upstream.status }, upstream.status === 404 ? 404 : 502);
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      return json({ error: 'upstream_not_image' }, 502);
    }

    const resHeaders = new Headers(upstream.headers);
    resHeaders.set('Cache-Control', 'public, max-age=86400');
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
