/**
 * Generic Cloudflare Cron Trigger adapter for PixivFlow (external-clock mode).
 *
 * This Worker is a *dumb clock*. It holds no PixivFlow business state: it never
 * talks to Pixiv, never picks works, never hardcodes schedule names. On each
 * cron fire it looks up the PixivFlow SCHEDULE ID bound to that cron (a simple
 * data-driven mapping, so any number/shape of schedule works) and POSTs to that
 * schedule's authenticated trigger URL. The woken PixivFlow process resolves the
 * canonical occurrence itself from its OWN cron + timezone, so this worker needs
 * no knowledge of slots, morning/evening, or dates — and duplicate/retry fires
 * are idempotent (they converge on one durable occurrence).
 *
 * Replaceable: any reliable HTTP scheduler (cron-job.org, GitHub Actions, a host
 * cron + curl) can take this Worker's place; PixivFlow Core never changes.
 *
 * Configuration:
 *   Secret SCHEDULE_TRIGGER_URL   base URL, e.g. https://<app>.fly.dev
 *   Secret SCHEDULE_TRIGGER_TOKEN bearer token (== PixivFlow SCHEDULER_TRIGGER_TOKEN)
 *   Var    SCHEDULES              JSON: { "<cron-expr>": "<scheduleId>", ... }
 *
 * The map keys must EXACTLY match the [triggers] crons below. Example (Beijing
 * 10:00/18:00 == UTC 02:00/10:00) mapping to arbitrary schedule ids:
 *   SCHEDULES = {"0 2 * * *":"morning","0 10 * * *":"evening"}
 * Another deployment maps the same crons to different ids, e.g.
 *   {"0 2 * * *":"daily-ranking","0 10 * * *":"evening-digest","0 0,6,12,18 * * *":"artist-watch"}
 */

export interface Env {
  SCHEDULE_TRIGGER_URL: string;
  SCHEDULE_TRIGGER_TOKEN: string;
  /** JSON map: cron expression (matches [triggers]) -> PixivFlow schedule id. */
  SCHEDULES?: string;
}

/** Parse the SCHEDULES cron->scheduleId map; tolerate whitespace / bad JSON. */
function scheduleMap(env: Env): Record<string, string> {
  try {
    const parsed = env.SCHEDULES ? JSON.parse(env.SCHEDULES) : {};
    const out: Record<string, string> = {};
    for (const [cron, id] of Object.entries(parsed)) {
      if (typeof id === 'string' && id.trim()) out[cron] = id.trim();
    }
    return out;
  } catch {
    return {};
  }
}

/** Trigger ONE schedule by id (idempotent). Returns the HTTP result. */
async function triggerSchedule(
  env: Env,
  scheduleId: string,
  label?: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const base = env.SCHEDULE_TRIGGER_URL.replace(/\/+$/, '');
  const url = `${base}/internal/schedules/${encodeURIComponent(scheduleId)}/run`;
  const controller = new AbortController();
  // Cold start + a serial multi-target run can take a few minutes. Cap
  // generously; the occurrence ledger makes the next fire a safe resume.
  const timer = setTimeout(() => controller.abort(), 8 * 60 * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SCHEDULE_TRIGGER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(label ? { label } : {}),
      signal: controller.signal,
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (err) {
    return { ok: false, status: 0, body: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // event.cron is the exact crontab line (from [triggers]) that fired.
    const map = scheduleMap(env);
    const scheduleId = map[event.cron];
    if (!scheduleId) {
      const known = Object.keys(map).join(', ') || '(none configured)';
      throw new Error(`no schedule id mapped for cron "${event.cron}"; SCHEDULES keys: ${known}`);
    }
    const result = await triggerSchedule(env, scheduleId);
    console.log(
      `schedule trigger cron="${event.cron}" id=${scheduleId}: ok=${result.ok} status=${result.status} body=${result.body}`,
    );
    if (!result.ok) {
      // Throw so Cloudflare marks the invocation failed; automatic retry and
      // the optional GitHub watchdog both re-POST the same idempotent trigger.
      throw new Error(`schedule ${scheduleId} trigger failed: ${result.status} ${result.body}`);
    }
  },

  // Manual smoke test / ops trigger (same bearer token):
  //   curl -X POST -H "Authorization: Bearer $TOKEN" \
  //     "https://<worker>.workers.dev/__trigger/morning"
  // Optional ?label=今日早班 to set a human provenance label.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/__trigger\/([^/]+)$/);
    if (m) {
      if (req.method !== 'POST') return new Response('use POST', { status: 405 });
      if ((req.headers.get('Authorization') ?? '') !== `Bearer ${env.SCHEDULE_TRIGGER_TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const scheduleId = decodeURIComponent(m[1]);
      const label = url.searchParams.get('label') ?? undefined;
      const result = await triggerSchedule(env, scheduleId, label);
      return new Response(JSON.stringify({ scheduleId, ...result }), {
        status: result.ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('pixivflow schedule clock', { status: 200 });
  },
};
