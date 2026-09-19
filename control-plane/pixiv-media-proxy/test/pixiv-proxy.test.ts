import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const BASE = 'https://media.example.com';

function dispatch(input: RequestInfo | URL, init?: RequestInit, fetchImpl?: typeof fetch) {
  const request = new Request(input, init);
  return (worker as { fetch: (r: Request, e: unknown) => Promise<Response> }).fetch(
    request,
    { PIXIV_PROXY_FETCH: fetchImpl ?? globalThis.fetch },
  );
}

describe('pixiv media proxy', () => {
  it('serves /health without touching upstream', async () => {
    const res = await dispatch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'pixiv-media-proxy' });
  });

  it('rewrites /pixiv/* to i.pximg.net and injects Referer + edge cache', async () => {
    let called: { url: string; method: string; referer?: string } | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      const headers = new Headers(init?.headers);
      called = { url, method: String(init?.method ?? 'GET'), referer: headers.get('referer') ?? undefined };
      return new Response('img', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as typeof fetch;

    const res = await dispatch(`${BASE}/pixiv/img-master/img/1_p0.jpg?format=webp`, {}, fakeFetch);
    expect(res.status).toBe(200);
    expect(called).toMatchObject({
      url: 'https://i.pximg.net/img-master/img/1_p0.jpg?format=webp',
      method: 'GET',
      referer: 'https://www.pixiv.net/',
    });
    expect(res.headers.get('cache-control')).toContain('max-age=86400');
    expect(await res.text()).toBe('img');
  });

  it('rejects non-GET/HEAD methods', async () => {
    const fakeFetch = (async () => new Response('never')) as typeof fetch;
    const res = await dispatch(`${BASE}/pixiv/x.jpg`, { method: 'POST' }, fakeFetch);
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: 'method_not_allowed' });
  });

  it('rejects traversal and unrelated paths', async () => {
    const fakeFetch = (async () => new Response('never')) as typeof fetch;
    for (const bad of ['/pixiv/../evil', '/pixiv/a//b', '/favicon.ico', '/api/x']) {
      const res = await dispatch(`${BASE}${bad}`, {}, fakeFetch);
      expect([400, 404]).toContain(res.status);
    }
  });

  it('drops session/auth headers and keeps only allowlisted client headers', async () => {
    let seen: Headers | undefined;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response('img', { status: 200, headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;

    await dispatch(`${BASE}/pixiv/x.png`, {
      headers: { cookie: 'a=b', authorization: 'Bearer x', range: 'bytes=0-99', accept: 'image/*' },
    }, fakeFetch);

    expect(seen!.get('referer')).toBe('https://www.pixiv.net/');
    expect(seen!.get('cookie')).toBeNull();
    expect(seen!.get('authorization')).toBeNull();
    expect(seen!.get('accept')).toBe('image/*');
    expect(seen!.get('range')).toBe('bytes=0-99');
  });

  it('rejects upstream non-image responses', async () => {
    const fakeFetch = (async () => new Response('<html>no</html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    const res = await dispatch(`${BASE}/pixiv/not-image`, {}, fakeFetch);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_not_image' });
  });

  it('maps upstream 404 to 404 and other upstream errors to 502', async () => {
    const notFound = (async () => new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    expect((await dispatch(`${BASE}/pixiv/missing`, {}, notFound)).status).toBe(404);

    const forbidden = (async () => new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } })) as typeof fetch;
    expect((await dispatch(`${BASE}/pixiv/denied`, {}, forbidden)).status).toBe(502);
  });
});
