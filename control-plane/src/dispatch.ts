import type { CronBinding } from './cron-map';

/**
 * The whole job: POST one authenticated trigger request and report what the
 * executor said about it.
 *
 * Why this is a single request and not a state machine: PixivFlow owns the
 * occurrence, the slot ledger and the retry policy. The trigger endpoint
 * resolves the occurrence, persists it and answers immediately
 * (accept-then-background), so the clock never waits on a 10-40 minute batch and
 * never needs to know whether one is running.
 *
 * Why retries are safe: the trigger endpoint is idempotent. Re-firing a schedule
 * yields one of the same four dispositions - accepted / running / completed /
 * rejected - and a duplicate never starts a second run. That is what makes a
 * bounded retry (the watchdog role) cheaper than trying to remember what we
 * already sent. Retrying a 503 is harmless too: the executor only answers 503
 * when it is genuinely saturated, and the next attempt finds the same state.
 */
export interface TriggerTarget {
  /** Origin of the executor, e.g. https://pixivflow-scheduler.fly.dev */
  baseUrl: string;
  /** Bearer for the trigger endpoint. Absent means refuse to send, never send unauthenticated. */
  token?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Total attempts including the first. Kept small to stay inside the cron wall clock. */
  attempts?: number;
  /** Per-attempt timeout. The machine may need a cold start, but not minutes. */
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

export interface DispatchOutcome {
  scheduleId: string;
  label: string;
  ok: boolean;
  /** How many requests were actually sent. */
  attempts: number;
  httpStatus?: number;
  disposition?: string;
  attemptAt: string;
  error?: string;
}

const DEFAULT_ATTEMPTS = 2;
/**
 * A cold start through the Fly proxy is seconds, not minutes: the trigger
 * endpoint answers as soon as the occurrence is persisted. 12s per attempt with
 * one retry keeps the worst case ~26s, inside a cron invocation's wall clock.
 */
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

interface TriggerResponse {
  status?: string;
  disposition?: string;
  scheduleId?: string;
}

/**
 * 5xx means "try again": the proxy or machine was not ready. Everything else is
 * a verdict about this occurrence and repeating the request cannot change it.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    // AbortError gets a stable name so logs are greppable.
    return error.name === 'AbortError' ? 'timeout' : `${error.name}: ${error.message}`;
  }
  return String(error);
}

export async function dispatchSchedule(
  binding: CronBinding,
  target: TriggerTarget
): Promise<DispatchOutcome> {
  const base = { scheduleId: binding.scheduleId, label: binding.label };
  const now = target.now ?? (() => new Date());
  const attemptAt = now().toISOString();

  const origin = (target.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!origin) {
    // Fail closed and loud: silently skipping would leave a schedule unrun and
    // look identical to "nothing was due".
    return { ...base, ok: false, attempts: 0, attemptAt, error: 'trigger base url is not configured' };
  }
  if (!/^https?:\/\//.test(origin)) {
    return { ...base, ok: false, attempts: 0, attemptAt, error: 'trigger base url must be http(s)' };
  }
  const token = (target.token ?? '').trim();
  if (!token) {
    return { ...base, ok: false, attempts: 0, attemptAt, error: 'trigger token is not configured' };
  }

  const url = `${origin}/internal/schedules/${encodeURIComponent(binding.scheduleId)}/run`;
  const doFetch = target.fetchImpl ?? fetch;
  const maxAttempts = Math.max(1, target.attempts ?? DEFAULT_ATTEMPTS);
  const timeoutMs = Math.max(1, target.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const retryDelayMs = Math.max(0, target.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);

  let sent = 0;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    sent += 1;
    try {
      // The body carries a label and nothing else: no date, no occurrence. The
      // executor decides which occurrence is due, so a late or duplicated trigger
      // can never back-fill history.
      const response = await doFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ label: binding.label }),
        signal: controller.signal,
      });

      const disposition = await readDisposition(response);
      if (response.ok || isRetryableStatus(response.status) === false) {
        return {
          ...base,
          ok: response.ok,
          attempts: sent,
          httpStatus: response.status,
          ...(disposition ? { disposition } : {}),
          attemptAt,
        };
      }
      lastError = `http ${response.status}${disposition ? ` (${disposition})` : ''}`;
    } catch (error) {
      lastError = describeError(error);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs);
    }
  }

  return { ...base, ok: false, attempts: sent, attemptAt, ...(lastError ? { error: lastError } : {}) };
}

async function readDisposition(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as TriggerResponse;
    return body?.disposition ?? body?.status;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
