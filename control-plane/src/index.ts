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
import { reconcileAll } from './reconciliation';
import { expirePendingReviews } from './reviews';
import { RECONCILIATION_LOOKBACK_HOURS, SCHEDULES, validateSchedules } from './schedules';
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
  /** Each bot has its own token: a bot1 callback can never act with bot2's token. */
  TELEGRAM_BOT1_TOKEN?: string;
  TELEGRAM_BOT2_TOKEN?: string;
}

function botTokens(env: Env): Record<string, string | undefined> {
  return { bot1: env.TELEGRAM_BOT1_TOKEN, bot2: env.TELEGRAM_BOT2_TOKEN };
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

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    validateSchedules(SCHEDULES);
    const store = new D1ControlStore(env.CONTROL_DB);
    const nowMs = Date.now();
    await reconcileAll(
      {
        store,
        provider: buildProvider(env),
        schedules: SCHEDULES,
        mode: executionMode(env),
        callbackUrl: `${(env.CONTROL_PLANE_URL ?? '').replace(/\/+$/, '')}/control`,
      },
      nowMs
    );
    // Undecided reviews expire on the same sweep: an old review must never be
    // published days later because a human finally tapped the button.
    await expirePendingReviews(store, nowMs);
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
      const summary = await reconcileAll(
        {
          store,
          provider: buildProvider(env),
          schedules: SCHEDULES,
          mode: executionMode(env),
          callbackUrl: `${(env.CONTROL_PLANE_URL ?? '').replace(/\/+$/, '')}/control`,
        },
        nowMs
      );
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
      return json({
        now,
        executionMode: executionMode(env),
        providerConfigured: Boolean(env.GITHUB_REPO && env.GITHUB_DISPATCH_TOKEN),
        telegramConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET && (env.TELEGRAM_BOT1_TOKEN || env.TELEGRAM_BOT2_TOKEN)),
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
