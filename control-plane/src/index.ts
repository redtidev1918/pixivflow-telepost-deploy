/**
 * Cloudflare Worker entry point: the durable control plane.
 *
 *  - `scheduled` runs one reconciliation sweep. It is NOT "run the task": it
 *    recomputes which occurrences should exist, reconciles the ledger and (see
 *    reconciliation.ts) converges execution state.
 *  - `fetch` is read-only observability plus the callback surface the disposable
 *    runners and Telegram use. Media never passes through here.
 */

import { D1ControlStore, type D1Like } from './d1-store';
import { nextOccurrence } from './occurrences';
import { reconcile } from './reconciliation';
import { RECONCILIATION_LOOKBACK_HOURS, SCHEDULES, validateSchedules } from './schedules';

export interface Env {
  CONTROL_DB: D1Like;
  /** `shadow` records intended dispatches without executing them. */
  EXECUTION_MODE?: string;
  RECONCILIATION_LOOKBACK_HOURS?: string;
}

function lookbackHours(env: Env): number {
  const parsed = Number(env.RECONCILIATION_LOOKBACK_HOURS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RECONCILIATION_LOOKBACK_HOURS;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    validateSchedules(SCHEDULES);
    const store = new D1ControlStore(env.CONTROL_DB);
    await reconcile(store, SCHEDULES, Date.now(), { lookbackHours: lookbackHours(env) });
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const store = new D1ControlStore(env.CONTROL_DB);

    if (url.pathname === '/health') {
      return json({ status: 'ok', service: 'pixivflow-control-plane' });
    }

    if (url.pathname === '/api/status') {
      const now = Date.now();
      const [counts, recent] = await Promise.all([
        store.countByStatus(),
        store.listRecentOccurrences(10),
      ]);
      return json({
        now,
        executionMode: env.EXECUTION_MODE ?? 'shadow',
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
      });
    }

    return json({ error: 'not found' }, 404);
  },
};
