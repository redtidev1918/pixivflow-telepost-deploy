import { CRONS, bindingFor, CRON_MAP } from './cron-map';
import { dispatchSchedule, newAttemptId } from './dispatch';

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

    const scheduledTime = new Date(controller.scheduledTime).toISOString();
    // One id for the whole invocation, minted here so it can appear on the line
    // logged *before* the POST and on the one logged after it. Without a shared
    // id, "the clock never fired", "the clock fired and the POST failed" and "the
    // executor rejected it" all looked like the same silence.
    const attemptId = newAttemptId();

    console.log(
      JSON.stringify({
        event: 'trigger.dispatch_started',
        // snake_case meta keys, and `attempt_id` on the terminal line too, so a
        // single grep over the log index joins the two halves of a dispatch.
        attempt_id: attemptId,
        provider: 'cloudflare',
        schedule_id: binding.scheduleId,
        cron: controller.cron,
        scheduled_time: scheduledTime,
        label: binding.label,
        // Hostname only. The configured URL is never logged (it can carry
        // userinfo); `/health` already reports the host. `null` means "we did not
        // know where we were sending", which is worth seeing rather than omitting.
        target_host: triggerHost(env.PIXIVFLOW_TRIGGER_BASE_URL),
      })
    );

    const outcome = await dispatchSchedule(binding, {
      baseUrl: env.PIXIVFLOW_TRIGGER_BASE_URL ?? '',
      token: env.SCHEDULER_TRIGGER_TOKEN,
      attemptId,
      // This Worker is the SECONDARY external clock. The tag is correlation
      // metadata: it is logged by the executor and decides nothing.
      provider: 'cloudflare',
      ...(env.DISPATCH_FETCH ? { fetchImpl: env.DISPATCH_FETCH } : {}),
    });

    // `attemptId`/`elapsedMs` are re-emitted under the snake_case names that
    // `trigger.dispatch_started` uses. Every other outcome field keeps its
    // existing name and meaning: an existing log consumer reads them.
    const { attemptId: reportedAttemptId, elapsedMs, ...reported } = outcome;

    console.log(
      JSON.stringify({
        event: 'trigger.dispatched',
        cron: controller.cron,
        scheduledTime,
        attempt_id: reportedAttemptId,
        elapsed_ms: elapsedMs,
        ...reported,
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

/**
 * Configured/missing readiness - never a secret value, only whether it is set.
 *
 * Read this as CONFIGURATION, not as health. `ok` means "an origin and a token
 * are both present"; `tokenConfigured` means exactly what it says and nothing
 * more. Neither says that a schedule ran, that the last trigger was admitted, or
 * that a given occurrence was ever dispatched - and this Worker cannot answer
 * those questions from here: it keeps no state, so there is no observation to
 * report. A counter added for the occasion would not even be that: a Worker
 * isolate is recycled and one isolate does not see another isolate's dispatches.
 *
 * To answer "did the 02:00Z occurrence dispatch", read the two log events and
 * join them on `attempt_id`; to answer "was it admitted", join that id to the
 * executor's logs. There is deliberately no `dispatchObserved` field: inventing
 * one would mean storing business state in the clock.
 */
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

/**
 * Hostname of the configured trigger origin, for the dispatch log line.
 *
 * Hostname only, so a URL carrying userinfo can never put a credential into the
 * log index. Unset or unparseable is reported as `null`: "we did not know where
 * we were sending" is a fact worth seeing, not a missing key.
 */
function triggerHost(baseUrl: string | undefined): string | null {
  try {
    return new URL((baseUrl ?? '').trim()).hostname || null;
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
