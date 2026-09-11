import { CRONS, bindingFor, CRON_MAP } from './cron-map';
import { dispatchSchedule } from './dispatch';

/**
 * Cloudflare Worker: the clock, and nothing else.
 *
 * Responsibility, in one sentence: turn "this cron expression just fired" into
 * "this schedule id should be triggered on PixivFlow", and stop there.
 *
 * What it deliberately does not own any more: occurrences, slot state,
 * executions, review decisions, publishing, credentials, the D1 shadow ledger or
 * the Telegram webhook. Those are PixivFlow's (execution) and TelePost's
 * (submission/review/publish) authority. A second copy here is how the system
 * ended up with two answers to the same question.
 *
 * There is no database binding. If a change here needs one, the change belongs
 * in PixivFlow.
 */
export interface Env {
  /** Origin of the authenticated PixivFlow schedule trigger, e.g. https://pixivflow-scheduler.fly.dev */
  PIXIVFLOW_TRIGGER_BASE_URL?: string;
  /** Bearer for the trigger endpoint. Set with `wrangler secret put`, never in wrangler.toml. */
  SCHEDULER_TRIGGER_TOKEN?: string;
  /** Optional override used by tests and by `wrangler dev`. */
  DISPATCH_FETCH?: typeof fetch;
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const binding = bindingFor(controller.cron);
    if (!binding) {
      // A cron that fires without a mapping means wrangler.toml and cron-map.ts
      // drifted apart; say so instead of quietly doing nothing.
      console.error(
        JSON.stringify({
          event: 'trigger.unmapped',
          cron: controller.cron,
          scheduledTime: new Date(controller.scheduledTime).toISOString(),
          known: CRONS,
        })
      );
      return;
    }

    const outcome = await dispatchSchedule(binding, {
      baseUrl: env.PIXIVFLOW_TRIGGER_BASE_URL ?? '',
      token: env.SCHEDULER_TRIGGER_TOKEN,
      ...(env.DISPATCH_FETCH ? { fetchImpl: env.DISPATCH_FETCH } : {}),
    });

    console.log(
      JSON.stringify({
        event: 'trigger.dispatched',
        cron: controller.cron,
        scheduledTime: new Date(controller.scheduledTime).toISOString(),
        ...outcome,
      })
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method !== 'GET') {
      return json({ error: 'method not allowed' }, 405);
    }
    switch (pathname) {
      case '/':
      case '/health':
      case '/api/health':
        return json(readiness(env));
      case '/api/schedules':
        // Read-only view of the deployment glue. There is nothing else to expose.
        return json({
          crons: CRONS,
          schedules: Object.entries(CRON_MAP).map(([cron, binding]) => ({
            cron,
            scheduleId: binding.scheduleId,
            label: binding.label,
          })),
        });
      default:
        return json({ error: 'not found' }, 404);
    }
  },
};

/** Configured/missing readiness - never a secret value, only whether it is set. */
function readiness(env: Env): Record<string, unknown> {
  const baseUrl = (env.PIXIVFLOW_TRIGGER_BASE_URL ?? '').trim();
  return {
    ok: Boolean(baseUrl) && Boolean((env.SCHEDULER_TRIGGER_TOKEN ?? '').trim()),
    role: 'schedule-trigger-clock',
    schedules: CRONS.length,
    triggerBaseUrl: baseUrl ? new URL(baseUrl).host : null,
    tokenConfigured: Boolean((env.SCHEDULER_TRIGGER_TOKEN ?? '').trim()),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
