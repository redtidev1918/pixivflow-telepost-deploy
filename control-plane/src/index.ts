/**
 * Cloudflare Worker entry point: the durable control plane.
 *
 *  - `scheduled` runs one reconciliation sweep. It is NOT "run the task": it
 *    recomputes which occurrences should exist, adopts the execution provider's
 *    verdict for anything in flight, then starts only the attempts that are due.
 *  - `fetch` serves read-only observability (`/api/status`) and the idempotent
 *    runner callbacks (`/control/executions/:id/...`). Media never passes here.
 */

import { D1ControlStore, type D1Like } from './d1-store';
import { GitHubActionsExecutionProvider } from './github-provider';
import { instantToLocal, nextOccurrence, occurrenceFor } from './occurrences';
import type { DispatchRequest, DispatchResult, ExecutionProvider, ProviderRun } from './provider';
import type { ReconciliationRunRow, ReconciliationSummary } from './store';
import { reconcileAll } from './reconciliation';
import { expirePendingReviews, reapStalePublishing } from './reviews';
import {
  RECONCILIATION_LOOKBACK_HOURS,
  SCHEDULES,
  SWEEP_LATE_MINUTES,
  SWEEP_STALLED_MINUTES,
  validateSchedules,
} from './schedules';
import { handleControl } from './routes/control';
import { handleTelegramWebhook } from './routes/telegram';
import { BotRegistry } from './telegram/client';

export interface Env {
  CONTROL_DB: D1Like;
  /** `live` publishes; `shadow`/`dry-run` must not touch the real channel. */
  EXECUTION_MODE?: string;
  RECONCILIATION_LOOKBACK_HOURS?: string;
  /** `owner/repo` hosting the batch workflow. */
  GITHUB_REPO?: string;
  GITHUB_WORKFLOW?: string;
  GITHUB_REF?: string;
  /** PixivFlow ref the dispatched runners must execute. */
  PIXIVFLOW_REF?: string;
  /**
   * TEMPORARY MIGRATION AUTH: a PAT stands in until a GitHub App is wired up
   * (see the control-plane README). Never logged.
   */
  GITHUB_DISPATCH_TOKEN?: string;
  /** Bearer the runner uses for the claim/result callbacks. */
  CALLBACK_SECRET?: string;
  /**
   * This Worker's own public base URL. A cron trigger has no request URL, so the
   * runner cannot be told where to call back without it.
   */
  CONTROL_PLANE_URL?: string;
  /** Telegram webhook verification (per-webhook secret_token). */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /**
   * Each bot has its own token: a bot1 callback can never act with bot2's token.
   * Any `TELEGRAM_<ID>_TOKEN` is picked up, so adding a bot (the shadow/test bot
   * the migration needs) is a secret, not a code change.
   */
  TELEGRAM_BOT1_TOKEN?: string;
  TELEGRAM_BOT2_TOKEN?: string;
  [key: string]: unknown;
}

/**
 * Discovers bots from the environment instead of listing them here.
 *
 * `TELEGRAM_BOT1_TOKEN` yields the bot id `bot1`, so the shadow bot needs one
 * secret and no deploy. A hardcoded list makes every new bot a code change,
 * which is the coupling this rewrite exists to remove.
 */
export function botTokens(env: Env): Record<string, string | undefined> {
  const tokens: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = /^TELEGRAM_(.+)_TOKEN$/.exec(key);
    if (!match) continue;
    if (typeof value === 'string' && value.length > 0) tokens[match[1]!.toLowerCase()] = value;
  }
  return tokens;
}

function lookbackHours(env: Env): number {
  const parsed = Number(env.RECONCILIATION_LOOKBACK_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RECONCILIATION_LOOKBACK_HOURS;
}

function executionMode(env: Env): 'live' | 'shadow' | 'dry-run' {
  const mode = (env.EXECUTION_MODE ?? 'shadow').trim();
  return mode === 'live' || mode === 'dry-run' ? mode : 'shadow';
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * A disabled provider keeps the sweep working (occurrences are still recorded,
 * the failure is visible in the execution row) instead of crashing the cron when
 * the deployment is not configured yet.
 */
class UnconfiguredProvider implements ExecutionProvider {
  readonly name = 'unconfigured';
  readonly ready = false;
  constructor(private readonly reason: string) {}
  async dispatch(_request: DispatchRequest): Promise<DispatchResult> {
    return { accepted: false, detail: this.reason };
  }
  async getRun(_runId: string): Promise<ProviderRun> {
    throw new Error(this.reason);
  }
  async cancel(): Promise<void> {}
  async listRecentRuns(): Promise<ProviderRun[]> {
    return [];
  }
}

function buildProvider(env: Env): ExecutionProvider {
  if (!env.GITHUB_REPO || !env.GITHUB_DISPATCH_TOKEN) {
    return new UnconfiguredProvider('execution provider not configured: GITHUB_REPO/GITHUB_DISPATCH_TOKEN missing');
  }
  if (!env.CONTROL_PLANE_URL) {
    return new UnconfiguredProvider('CONTROL_PLANE_URL missing: runners would have nowhere to report back');
  }
  return new GitHubActionsExecutionProvider({
    repo: env.GITHUB_REPO,
    workflowFile: env.GITHUB_WORKFLOW ?? 'pixivflow-batch.yml',
    token: env.GITHUB_DISPATCH_TOKEN,
    ref: env.GITHUB_REF ?? 'main',
  });
}

/**
 * Answers "did the clock run?" from durable state.
 *
 * `unknown` until the first sweep: a freshly deployed worker has not proven its
 * cron yet, and reporting `ok` there would be a lie.
 */
export function clockHealth(
  sweeps: ReconciliationRunRow[],
  nowMs: number
): { lastSweepAt: number | null; ageMinutes: number | null; state: 'ok' | 'late' | 'stalled' | 'unknown' } {
  const last = sweeps[0];
  if (!last) return { lastSweepAt: null, ageMinutes: null, state: 'unknown' };
  const ageMinutes = (nowMs - last.startedAt) / 60_000;
  const state: 'ok' | 'late' | 'stalled' =
    ageMinutes > SWEEP_STALLED_MINUTES ? 'stalled' : ageMinutes > SWEEP_LATE_MINUTES ? 'late' : 'ok';
  return { lastSweepAt: last.startedAt, ageMinutes: Math.round(ageMinutes * 10) / 10, state };
}

/**
 * One reconciliation sweep.
 *
 * The cron and the ops trigger MUST run the same thing: a hand-triggered sweep
 * that skips a step is worse than no ops trigger, because it reports success
 * while the clock would have done more. That is exactly how the stale-claim
 * reaper was first wired (cron only) and missed by a manual sweep.
 */
async function sweep(
  store: D1ControlStore,
  env: Env,
  nowMs: number
): Promise<ReconciliationSummary> {
  const summary = await reconcileAll(
    {
      store,
      provider: buildProvider(env),
      schedules: SCHEDULES,
      mode: executionMode(env),
      callbackUrl: `${(env.CONTROL_PLANE_URL ?? '').replace(/\/+$/, '')}/control`,
      pixivflowRef: env.PIXIVFLOW_REF ?? 'master',
    },
    nowMs
  );

  // Undecided reviews expire on the same sweep: an old review must never be
  // published days later because a human finally tapped the button.
  // One registry for the sweep: building it per expired review would re-read the
  // environment on every iteration.
  const bots = new BotRegistry(botTokens(env));
  await expirePendingReviews(store, nowMs, undefined, undefined, (botId) => bots.get(botId));

  // Claims abandoned mid-publish converge here instead of sitting invisible. With
  // the copy recorded they resolve as published; without it they become uncertain,
  // because a blind retry is how the same media gets posted twice.
  const reaped = await reapStalePublishing(store, nowMs);
  if (reaped.published > 0 || reaped.uncertain > 0) {
    await store.logEvents([
      { ts: nowMs, event: 'review_claims_reaped', detail: JSON.stringify(reaped) },
    ]);
  }

  return summary;
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    validateSchedules(SCHEDULES);
    const store = new D1ControlStore(env.CONTROL_DB);
    await sweep(store, env, Date.now());
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const store = new D1ControlStore(env.CONTROL_DB);

    const controlResponse = await handleControl(request, store, url, env.CALLBACK_SECRET);
    if (controlResponse) return controlResponse;

    // Telegram webhook: review decisions (see routes/telegram.ts). Handled before
    // anything else so a decision is never gated behind read-only plumbing.
    const registry = new BotRegistry(botTokens(env));
    const telegramResponse = await handleTelegramWebhook(request, store, url, {
      ...(env.TELEGRAM_WEBHOOK_SECRET ? { TELEGRAM_WEBHOOK_SECRET: env.TELEGRAM_WEBHOOK_SECRET } : {}),
      getBot: (botId) => registry.get(botId),
    });
    if (telegramResponse) return telegramResponse;

    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'pixivflow-control-plane' });
    }

    // Ops trigger for one sweep. The cron is the clock; this exists so shadow
    // validation and cutover can be verified deterministically instead of waiting
    // for the next 10-minute tick. Same secret as the runner callbacks.
    if (url.pathname === '/api/reconcile') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!env.CALLBACK_SECRET) return json({ error: 'no callback secret configured' }, 503);
      const header = request.headers.get('authorization') ?? '';
      if (header !== `Bearer ${env.CALLBACK_SECRET}`) return json({ error: 'unauthorized' }, 401);
      validateSchedules(SCHEDULES);
      const nowMs = Date.now();
      const summary = await sweep(store, env, nowMs);
      return json({ ok: true, now: nowMs, summary });
    }

    // Ops: create (idempotently) the slot for a canonical occurrence. Shadow
    // validation and the fault-injection suite need to act on a KNOWN slot
    // instead of waiting for the clock to produce one.
    if (url.pathname === '/api/slots') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      if (!env.CALLBACK_SECRET) return json({ error: 'no callback secret configured' }, 503);
      if (request.headers.get('authorization') !== `Bearer ${env.CALLBACK_SECRET}`) {
        return json({ error: 'unauthorized' }, 401);
      }
      let body: { schedule_id?: string; occurrence_at?: number; local_date?: string; local_time?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return json({ error: 'invalid json body' }, 400);
      }
      const schedule = SCHEDULES.find((candidate) => candidate.id === body.schedule_id);
      if (!schedule) return json({ error: 'unknown schedule_id' }, 400);

      // The caller may give the canonical instant directly, or a wall clock that
      // is converted through the schedule's own timezone (never the Worker's).
      let occurrence;
      if (typeof body.occurrence_at === 'number' && Number.isFinite(body.occurrence_at)) {
        const local = instantToLocal(body.occurrence_at, schedule.timezone);
        occurrence = occurrenceFor(schedule, local.date, local.time);
      } else if (body.local_date && body.local_time) {
        occurrence = occurrenceFor(schedule, body.local_date, body.local_time);
      } else {
        return json({ error: 'provide occurrence_at or local_date+local_time' }, 400);
      }

      const nowMs = Date.now();
      const result =
        occurrence.occurrenceAt > nowMs
          ? 'future'
          : await store.insertOccurrenceIfAbsent(occurrence, nowMs);
      const row = await store.getOccurrence(occurrence.slotId);
      return json({ ok: true, result, now: nowMs, slot: row });
    }

    if (url.pathname === '/api/status') {
      const now = Date.now();
      const [counts, recent] = await Promise.all([
        store.countByStatus(),
        store.listRecentOccurrences(10),
      ]);
      const recentExecutions = await store.listOpenExecutions(10);
      const pendingReviews = await store.listPendingReviews(10);
      const recentSweeps = await store.listRecentReconciliations(10);
      const reviewsByStatus = await store.countReviewsByStatus();
      return json({
        now,
        // The cron is the only clock, so its liveness is the single most important
        // thing to see. A stalled sweep means occurrences will simply not appear.
        clock: clockHealth(recentSweeps, now),
        reviewsByStatus,
        recentReconciliations: recentSweeps,
        executionMode: executionMode(env),
        providerConfigured: Boolean(env.GITHUB_REPO && env.GITHUB_DISPATCH_TOKEN),
        telegramConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET && Object.keys(botTokens(env)).length > 0),
        lookbackHours: lookbackHours(env),
        nextOccurrence: nextOccurrence(SCHEDULES, now),
        schedules: SCHEDULES.map((schedule) => ({
          id: schedule.id,
          botId: schedule.botId,
          times: schedule.times,
          timezone: schedule.timezone,
          targets: schedule.targets,
          dispatchDeadlineHours: schedule.dispatchDeadlineHours,
          maxAttempts: schedule.maxAttempts,
        })),
        countsByStatus: counts,
        recentOccurrences: recent,
        pendingReviews: pendingReviews.map((review) => ({
          id: review.id,
          botId: review.botId,
          slotId: review.slotId,
          targetId: review.targetId,
          workId: review.workId,
          status: review.status,
          createdAt: review.createdAt,
        })),
        recentExecutions: recentExecutions.map((execution) => ({
          id: execution.id,
          slotId: execution.slotId,
          attempt: execution.attempt,
          status: execution.status,
          providerRunId: execution.providerRunId,
        })),
      });
    }

    return json({ error: 'not found' }, 404);
  },
};
