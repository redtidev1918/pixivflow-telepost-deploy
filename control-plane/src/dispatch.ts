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
  /**
   * Self-identification sent as `X-Schedule-Provider`, for correlation only.
   * Never used for authorization and never for occurrence identity: the executor
   * logs it and nothing else.
   */
  provider?: string;
  /** Per-attempt timeout. The machine may need a cold start, but not minutes. */
  timeoutMs?: number;
  retryDelayMs?: number;
  now?: () => Date;
  /**
   * Explicit invocation id. `index.ts` mints one and passes it in so the
   * `trigger.dispatch_started` line it logs *before* this call carries the same
   * id as the `trigger.dispatched` line after it. Omitted means mint one here.
   */
  attemptId?: string;
  /** Test seam for the invocation id. Defaults to `newAttemptId()`. */
  newAttemptId?: () => string;
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
  /**
   * Identifies the *invocation*, not the HTTP request: identical across the
   * retries of one call, different between calls. Sent to the executor as the
   * `x-schedule-attempt-id` header so its side of the conversation can be joined
   * to this one.
   */
  attemptId: string;
  /** Wall time of the whole call, retries and the retry sleep included. */
  elapsedMs: number;
}

/**
 * One id per dispatched invocation, in its own namespace: a UUID generated from
 * nothing else. Deliberately not derived from the token, the origin or the
 * schedule id, so it can be logged and shipped into the executor's logs without
 * carrying any part of a secret.
 *
 * Why it exists: the clock used to emit a single terminal line with no id at
 * all, so a schedule occurrence that went missing could not be joined to the
 * executor's side of the conversation - whether the POST was ever sent, and
 * whether it was admitted or rejected, were both unknowable after the fact.
 */
export function newAttemptId(): string {
  return crypto.randomUUID();
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

  // Exactly one id per call, resolved before the loop and before any early
  // return, so every outcome - including "we refused to send" - is joinable with
  // the caller's `trigger.dispatch_started` line.
  const attemptId = target.attemptId ?? (target.newAttemptId ?? newAttemptId)();
  const provider = (target.provider ?? '').trim();
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  const origin = (target.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!origin) {
    // Fail closed and loud: silently skipping would leave a schedule unrun and
    // look identical to "nothing was due".
    return {
      ...base,
      ok: false,
      attempts: 0,
      attemptAt,
      attemptId,
      elapsedMs: elapsed(),
      error: 'trigger base url is not configured',
    };
  }
  if (!/^https?:\/\//.test(origin)) {
    return {
      ...base,
      ok: false,
      attempts: 0,
      attemptAt,
      attemptId,
      elapsedMs: elapsed(),
      error: 'trigger base url must be http(s)',
    };
  }
  const token = (target.token ?? '').trim();
  if (!token) {
    return {
      ...base,
      ok: false,
      attempts: 0,
      attemptAt,
      attemptId,
      elapsedMs: elapsed(),
      error: 'trigger token is not configured',
    };
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
          // The same id on every attempt of this invocation: a retry is the clock
          // repeating itself, not a second trigger. The executor logs this value,
          // which is what makes "was it admitted?" answerable after the fact.
          'x-schedule-attempt-id': attemptId,
          // Observability only; the executor must never authorize on this.
          ...(provider ? { 'x-schedule-provider': provider } : {}),
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
          attemptId,
          elapsedMs: elapsed(),
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

  return {
    ...base,
    ok: false,
    attempts: sent,
    attemptAt,
    attemptId,
    // Measured after the last retry sleep, so a bounded failure reports the time
    // the cron invocation actually spent, not just the time in flight.
    elapsedMs: elapsed(),
    ...(lastError ? { error: lastError } : {}),
  };
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
