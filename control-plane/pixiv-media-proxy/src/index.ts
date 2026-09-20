/**
 * Pixiv-first media proxy Worker.
 *
 * The route is allowlist-driven, not open-proxy driven. `/pixiv/*` remains a
 * legacy alias for `i.pximg.net`; `/media/<host>/<path>` reaches only hosts in
 * `MEDIA_PROXY_ALLOWED_HOSTS`. Upstream redirects are rejected so a supposedly
 * fixed origin cannot be used to bounce traffic to another domain.
 */
const PIXIV_HOST = 'i.pximg.net';
const PIXIV_REFERER = 'https://www.pixiv.net/';
const LEGACY_PREFIX = '/pixiv/';

const CLIENT_HEADERS = ['Accept', 'Accept-Encoding', 'Range', 'If-Range', 'If-Modified-Since', 'If-None-Match'] as const;
const RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Content-Disposition',
  'Accept-Ranges',
  'ETag',
  'Last-Modified',
  'Expires',
  'Date',
] as const;

export interface Env {
  /** Comma-separated exact source hosts. No ports, wildcards, schemes, or paths. */
  MEDIA_PROXY_ALLOWED_HOSTS?: string;
  /** Test/development override of the global fetch. */
  PIXIV_PROXY_FETCH?: typeof fetch;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function allowlistedHosts(env: Env): Set<string> {
  const raw = env.MEDIA_PROXY_ALLOWED_HOSTS ?? '';
  const hosts = new Set<string>();
  for (const item of raw.split(',')) {
    const host = item.trim().toLowerCase();
    // Keep the misconfiguration loud: a broad allowlist would make /media an
    // open proxy. Exact DNS hostnames only.
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) hosts.add(host);
  }
  return hosts;
}

function upstreamFor(pathname: string, env: Env): { host: string; suffix: string } | null {
  if (pathname.startsWith(LEGACY_PREFIX)) {
    return { host: PIXIV_HOST, suffix: pathname.slice(LEGACY_PREFIX.length) };
  }

  const match = /^\/media\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return null;
  let host: string;
  try {
    host = decodeURIComponent(match[1] ?? '').toLowerCase();
  } catch {
    return null;
  }
  if (!allowlistedHosts(env).has(host)) return null;
  return { host, suffix: match[2] ?? '' };
}

function safeSuffix(suffix: string): boolean {
  // URL.pathname may still contain percent-encoded traversal after normalization.
  if (!suffix || /(?:^|\/)\.\.(?:$|\/)|\/\//i.test(suffix) || /%2e%2e|%2f|%5c/i.test(suffix)) {
    return false;
  }
  return suffix.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function imageHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'pixiv-media-proxy' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    const targetInfo = upstreamFor(url.pathname, env);
    if (!targetInfo) return json({ error: 'not_found' }, 404);
    if (!safeSuffix(targetInfo.suffix)) return json({ error: 'invalid_path' }, 400);

    const target = `https://${targetInfo.host}/${targetInfo.suffix}${url.search}`;
    const headers = new Headers();
    if (targetInfo.host === PIXIV_HOST) headers.set('Referer', PIXIV_REFERER);
    for (const name of CLIENT_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const fetchImpl: typeof fetch = env.PIXIV_PROXY_FETCH ?? fetch;
    const upstream = await fetchImpl(target, {
      method: request.method,
      headers,
      redirect: 'manual',
      cf: { cacheTtl: 86400, cacheEverything: true },
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      return json({ error: 'upstream_redirect_not_allowed' }, 502);
    }

    if (upstream.status >= 400) {
      return json({ error: 'upstream_error', status: upstream.status }, upstream.status === 404 ? 404 : 502);
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      return json({ error: 'upstream_not_image' }, 502);
    }

    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: imageHeaders(upstream.headers),
    });
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}
