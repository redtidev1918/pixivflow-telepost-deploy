import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';
import { dispatchSchedule } from '../src/dispatch';
import { CRON_MAP } from '../src/cron-map';

/**
 * Why this file exists (2026-09-13 incident).
 *
 * The 10:00/10:10 Asia/Shanghai occurrences for bot1-daily and bot2-daily did not
 * run, and nothing in the logs could say why: the clock emitted one terminal line
 * with no correlation id, so "the cron never fired", "the cron fired and the POST
 * failed" and "the executor rejected it" were indistinguishable after the fact.
 *
 * These tests pin the two things that close that gap: one invocation id shared by
 * both log lines and sent to the executor on the wire, and a line that is written
 * *before* the request so an absent pair is itself the signal.
 *
 * Nothing here touches the network: every request goes through the `fetchImpl`
 * seam `dispatchSchedule` already had, or the `DISPATCH_FETCH` env seam.
 */
/**
 * Resolved by schedule id, not by the literal cron key: the production cron
 * strings are operational configuration (the secondary clock's offset lives in
 * them), and this file is about the dispatch envelope, not about the schedule.
 */
const BOT1 = Object.values(CRON_MAP).find((b) => b.scheduleId === 'bot1-daily')!;
const cronOf = (scheduleId: string): string =>
  Object.keys(CRON_MAP).find((cron) => CRON_MAP[cron]!.scheduleId === scheduleId)!;
const BOT1_CRON = cronOf('bot1-daily');
const BOT2_CRON = cronOf('bot2-daily');
const BASE = { baseUrl: 'https://pixivflow-scheduler.fly.dev', token: 'trigger-token' };
const SECRET = 'hunter2-super-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Records every outbound request so the headers can be inspected per attempt. */
function recordingFetch(respond: (call: number) => Response): {
  calls: Array<{ url: string; headers: Record<string, string> }>;
  fetchImpl: typeof fetch;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(calls.length);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function controller(cron: string, scheduledTime = Date.parse('2026-09-13T02:00:00Z')): ScheduledController {
  return { cron, scheduledTime, noRetry: () => {} };
}

interface CapturedLog {
  method: 'log' | 'error' | 'warn';
  line: string;
  parsed: Record<string, unknown>;
}

/** Every console line the Worker writes, parsed. Output is never printed. */
function captureConsole(): { lines: CapturedLog[]; restore: () => void } {
  const lines: CapturedLog[] = [];
  const spies = (['log', 'error', 'warn'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const line = args.map((arg) => String(arg)).join(' ');
      lines.push({ method, line, parsed: JSON.parse(line) as Record<string, unknown> });
    }),
  );
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dispatchSchedule: the invocation id on the wire', () => {
  it('sends an attempt id header that is a non-empty string and never the token', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));

    const outcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl });

    const sent = calls[0]!.headers['x-schedule-attempt-id'] ?? '';
    expect(sent.length).toBeGreaterThan(0);
    // The id is generated in its own namespace: it must not be the bearer, nor
    // contain it, because this value travels into the executor's logs.
    expect(sent).not.toBe(BASE.token);
    expect(sent).not.toContain(BASE.token);
    expect(outcome.attemptId).toBe(sent);
  });

  it('uses one id across the retries of a call, and a fresh one per call', async () => {
    // 503 then 200: the second request is the same invocation repeating itself.
    const first = recordingFetch((call) =>
      call === 1 ? jsonResponse({ status: 'saturated' }, 503) : jsonResponse({ disposition: 'running' }),
    );
    const firstOutcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl: first.fetchImpl, retryDelayMs: 0 });

    expect(first.calls).toHaveLength(2);
    const [attempt1, attempt2] = first.calls;
    expect(attempt1!.headers['x-schedule-attempt-id']).toBeTruthy();
    // Same id on both attempts: it identifies the invocation, not the HTTP request.
    expect(attempt2!.headers['x-schedule-attempt-id']).toBe(attempt1!.headers['x-schedule-attempt-id']);
    expect(firstOutcome.attemptId).toBe(attempt1!.headers['x-schedule-attempt-id']);

    const second = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));
    const secondOutcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl: second.fetchImpl });

    // A new invocation is a new id, or the join would point at the wrong dispatch.
    expect(secondOutcome.attemptId).not.toBe(firstOutcome.attemptId);
    expect(second.calls[0]!.headers['x-schedule-attempt-id']).toBe(secondOutcome.attemptId);
  });

  it('mints exactly one id per call, before the first request', async () => {
    const newAttemptId = vi.fn(() => 'attempt-fixture-1');
    const { calls, fetchImpl } = recordingFetch((call) =>
      call === 1 ? jsonResponse({ status: 'saturated' }, 503) : jsonResponse({ disposition: 'running' }),
    );

    await dispatchSchedule(BOT1, { ...BASE, fetchImpl, newAttemptId, retryDelayMs: 0 });

    expect(calls).toHaveLength(2);
    expect(newAttemptId).toHaveBeenCalledTimes(1);
    expect(calls.every((call) => call.headers['x-schedule-attempt-id'] === 'attempt-fixture-1')).toBe(true);
  });

  it('uses an id supplied by the caller, so both log lines can share it', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));

    const outcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl, attemptId: 'caller-supplied-id' });

    expect(outcome.attemptId).toBe('caller-supplied-id');
    expect(calls[0]!.headers['x-schedule-attempt-id']).toBe('caller-supplied-id');
  });

  it('still mints an id when it refuses to send at all', async () => {
    // A refusal is also an invocation, and its two log lines still have to join.
    const outcome = await dispatchSchedule(BOT1, { baseUrl: '   ', token: 'tok', fetchImpl: vi.fn() as unknown as typeof fetch });

    expect(outcome.attempts).toBe(0);
    expect(typeof outcome.attemptId).toBe('string');
    expect(outcome.attemptId.length).toBeGreaterThan(0);
  });
});

describe('dispatchSchedule: provider tag', () => {
  it('sends X-Schedule-Provider as correlation metadata, never as authority', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));

    const outcome = await dispatchSchedule(BOT1, { ...BASE, fetchImpl, provider: 'cloudflare' });

    expect(outcome.ok).toBe(true);
    expect(calls[0]!.headers['x-schedule-provider']).toBe('cloudflare');
    // It is a name, not a credential: the only secret on the wire is the bearer.
    expect(calls[0]!.headers['x-schedule-provider']).not.toContain(SECRET);
    expect(JSON.stringify(calls[0]!.headers)).not.toContain(SECRET);
  });

  it('omits the header entirely when no provider is configured', async () => {
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));
    await dispatchSchedule(BOT1, { ...BASE, fetchImpl });
    // Omitted, so "an unidentified clock" stays distinguishable from a tagged one.
    expect(Object.prototype.hasOwnProperty.call(calls[0]!.headers, 'x-schedule-provider')).toBe(false);
  });
});

describe('dispatchSchedule: 401 is a verdict, not a hiccup', () => {
  it('reports the status, does not retry, and stops at the first attempt', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));

    const outcome = await dispatchSchedule(BOT1, {
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 3,
      retryDelayMs: 0,
    });

    // A rejected bearer cannot become accepted by repeating the request.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.attempts).toBe(1);
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(401);
  });
});

describe('dispatchSchedule: elapsedMs', () => {
  it('is a non-negative finite number on both the success and the failure path', async () => {
    const success = await dispatchSchedule(BOT1, {
      ...BASE,
      fetchImpl: recordingFetch(() => jsonResponse({ disposition: 'accepted' })).fetchImpl,
    });
    const failure = await dispatchSchedule(BOT1, {
      ...BASE,
      fetchImpl: vi.fn(async () => jsonResponse({ status: 'saturated' }, 503)) as unknown as typeof fetch,
      attempts: 2,
      retryDelayMs: 0,
    });

    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
    for (const [name, outcome] of [['success', success], ['failure', failure]] as const) {
      expect(Number.isFinite(outcome.elapsedMs), name).toBe(true);
      expect(outcome.elapsedMs, name).toBeGreaterThanOrEqual(0);
    }
  });

  it('counts the retry sleep, not just the time in flight', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'saturated' }, 503));

    const outcome = await dispatchSchedule(BOT1, {
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      attempts: 2,
      retryDelayMs: 40,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The wall clock of the call, retries and the sleep between them included.
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(40);
  });
});

describe('scheduled(): the two log events', () => {
  const env = (overrides: Partial<Env> = {}): Env => ({
    PIXIVFLOW_TRIGGER_BASE_URL: BASE.baseUrl,
    SCHEDULER_TRIGGER_TOKEN: SECRET,
    ...overrides,
  });

  it('emits dispatch_started then dispatched, joined by one attempt id', async () => {
    const { lines, restore } = captureConsole();
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));

    try {
      await worker.scheduled(controller(BOT1_CRON), env({ DISPATCH_FETCH: fetchImpl }));
    } finally {
      restore();
    }

    expect(lines.map((entry) => entry.parsed.event)).toEqual(['trigger.dispatch_started', 'trigger.dispatched']);

    const [started, dispatched] = lines;
    // Everything the operator needs to answer "did the clock even try?".
    expect(started!.parsed.attempt_id).toBeTruthy();
    expect(started!.parsed.schedule_id).toBe('bot1-daily');
    expect(started!.parsed.cron).toBe(BOT1_CRON);
    expect(started!.parsed.scheduled_time).toBe('2026-09-13T02:00:00.000Z');
    expect(started!.parsed.label).toBe(BOT1.label);
    expect(started!.parsed.target_host).toBe('pixivflow-scheduler.fly.dev');

    // The same id on both lines is the whole point: it is what lets one dispatch
    // be found in a log index that holds every run of every schedule.
    expect(dispatched!.parsed.event).toBe('trigger.dispatched');
    expect(dispatched!.parsed.attempt_id).toBe(started!.parsed.attempt_id);
    expect(dispatched!.parsed.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(calls[0]!.headers['x-schedule-attempt-id']).toBe(started!.parsed.attempt_id);

    // The pre-existing fields an existing log consumer reads are still there.
    expect(dispatched!.parsed).toMatchObject({
      scheduleId: 'bot1-daily',
      label: BOT1.label,
      ok: true,
      attempts: 1,
      httpStatus: 200,
      disposition: 'accepted',
    });
  });

  it('logs only the hostname of the configured origin, never userinfo or a secret', async () => {
    const { lines, restore } = captureConsole();
    const { fetchImpl } = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));

    try {
      await worker.scheduled(
        controller(BOT1_CRON),
        env({ PIXIVFLOW_TRIGGER_BASE_URL: 'https://user:url-password@example.internal:8443/trigger', DISPATCH_FETCH: fetchImpl }),
      );
    } finally {
      restore();
    }

    const [started] = lines;
    expect(started!.parsed.target_host).toBe('example.internal');
    expect(started!.line).not.toContain('url-password');
    expect(started!.line).not.toContain('/trigger');
  });

  it('never lets the trigger token or any prefix of it reach a log line', async () => {
    const { lines, restore } = captureConsole();
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({ disposition: 'accepted' }));

    try {
      await worker.scheduled(controller(BOT2_CRON), env({ DISPATCH_FETCH: fetchImpl }));
    } finally {
      restore();
    }

    // The request really did carry the token, so the assertions below are about
    // the logging and not about a fixture that never held a secret.
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(calls).toHaveLength(1);

    expect(lines.length).toBeGreaterThan(0);
    const body = lines.map((entry) => entry.line).join('\n');
    expect(body).not.toContain(SECRET);
    // The first 8 characters: a shortened id would already be a disclosure.
    expect(body).not.toContain(SECRET.slice(0, 8));
  });
});
