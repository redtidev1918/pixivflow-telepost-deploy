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
    const headers = new Headers(request.headers);
    headers.set('Referer', PIXIV_REFERER);
    headers.delete('cookie');
    headers.delete('authorization');

    const fetchImpl: typeof fetch = env.PIXIV_PROXY_FETCH ?? fetch;
    const upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    const resHeaders = new Headers(upstream.headers);
    resHeaders.set('Cache-Control', 'public, max-age=86400');
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
