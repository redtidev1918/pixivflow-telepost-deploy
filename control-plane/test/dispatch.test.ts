import { describe, expect, it, vi } from 'vitest';
import { dispatchSchedule } from '../src/dispatch';
import { CRON_MAP, bindingFor } from '../src/cron-map';

/**
 * The clock's whole behaviour is one authenticated POST, so the tests are about
 * what it refuses to do: send unauthenticated, send to a misconfigured origin,
 * or decide an occurrence's fate on its own.
 */
const BOT1 = CRON_MAP['0 2,10 * * *']!;
const BOT2 = CRON_MAP['10 2,10 * * *']!;
const BASE = { baseUrl: 'https://pixivflow-scheduler.fly.dev', token: 'trigger-token' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('cron map', () => {
  it('maps each cron expression to exactly one schedule id', () => {
    expect(Object.keys(CRON_MAP)).toHaveLength(2);
    expect(bindingFor('0 2,10 * * *')?.scheduleId).toBe('bot1-daily');
    expect(bindingFor('10 2,10 * * *')?.scheduleId).toBe('bot2-daily');
    // Whitespace tolerance: the trigger payload comes from the platform, not from us.
    expect(bindingFor('  10 2,10 * * *  ')?.scheduleId).toBe('bot2-daily');
    expect(bindingFor('*/10 * * * *')).toBeUndefined();
  });
});

describe('dispatchSchedule', () => {
  it('refuses to send when the trigger origin is not configured', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const outcome = await dispatchSchedule(BOT1, { baseUrl: '   ', token: 'tok', fetchImpl });

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(0);
    expect(outcome.error).toContain('base url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses to send when the trigger token is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const outcome = await dispatchSchedule(BOT1, { baseUrl: BASE.baseUrl, token: '  ', fetchImpl });

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(0);
    expect(outcome.error).toContain('token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-http origin instead of probing it', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const outcome = await dispatchSchedule(BOT1, { baseUrl: 'file:///etc/passwd', token: 't', fetchImpl });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain('http');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the schedule id and nothing that could identify an occurrence', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ disposition: 'accepted' });
    }) as unknown as typeof fetch;

    const outcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl });

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(outcome.disposition).toBe('accepted');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE.baseUrl}/internal/schedules/bot1-daily/run`);
    expect(calls[0]!.init.method).toBe('POST');
    // The executor decides which occurrence is due. A body carrying a date would be
    // a second clock, and a late trigger would back-fill history.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ label: BOT1.label });
    expect(JSON.parse(String(calls[0]!.init.body))).not.toHaveProperty('occurrenceAt');
  });

  it('authenticates every attempt with the trigger bearer', async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>);
      return jsonResponse({ disposition: 'completed' });
    }) as unknown as typeof fetch;

    await dispatchSchedule(BOT2, { ...BASE, fetchImpl });

    expect(headers[0]!.authorization).toBe('Bearer trigger-token');
  });

  it('retries a 5xx once, because the proxy or machine may not be ready yet', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ status: 'saturated' }, 503)
        : jsonResponse({ disposition: 'running' });
    }) as unknown as typeof fetch;

    const outcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl, retryDelayMs: 0 });

    expect(calls).toBe(2);
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.disposition).toBe('running');
  });

  it('does not retry a verdict: 4xx is final', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unknown schedule' }, 404));

    const outcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, retryDelayMs: 0 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(404);
    expect(outcome.attempts).toBe(1);
  });

  it('reports a bounded failure after exhausting attempts', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'saturated' }, 503));

    const outcome = await dispatchSchedule(BOT1, {
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 2,
      retryDelayMs: 0,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(2);
    expect(outcome.error).toContain('503');
  });

  it('bounds a cold start instead of hanging inside the cron invocation', async () => {
    const fetchImpl = ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    const outcome = await dispatchSchedule(BOT1, {
      ...BASE,
      fetchImpl,
      attempts: 1,
      timeoutMs: 5,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('timeout');
  });

  it('tolerates an empty or non-JSON response body', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));

    const outcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(outcome.ok).toBe(true);
    expect(outcome.disposition).toBeUndefined();
  });
});
