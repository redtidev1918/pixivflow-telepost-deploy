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
});
