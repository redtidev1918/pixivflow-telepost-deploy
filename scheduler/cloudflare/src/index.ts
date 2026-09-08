/**
 * Cloudflare Cron Trigger adapter for PixivFlow + TelePost (Fly autosleep).
 *
 * This Worker is a *dumb clock*. It holds no business state: it never talks to
 * Pixiv, never picks works, never stores anything. On its cron schedule it POSTs
 * the slot name ("morning" / "evening") to the PixivFlow authenticated Slot API,
 * which wakes the stopped Fly machine via the Fly proxy and runs that slot
 * synchronously. All real state lives in PixivFlow's Slot ledger, so duplicate
 * or retried fires are idempotent.
 *
 * Secrets (set with `wrangler secret put`):
 *   SCHEDULE_TRIGGER_URL   e.g. https://<your-fly-app>.fly.dev/internal/schedules/run
 *   SCHEDULE_TRIGGER_TOKEN bearer token (must equal PixivFlow's SCHEDULER_TRIGGER_TOKEN)
 *
 * Cron times are UTC. Beijing 10:00/18:00 == UTC 02:00/10:00.
 */

export interface Env {
  SCHEDULE_TRIGGER_URL: string;
  SCHEDULE_TRIGGER_TOKEN: string;
}

/** Cron fires at UTC 02:00 (Beijing 10:00) and 10:00 (Beijing 18:00). */
function slotForUtcHour(hour: number): 'morning' | 'evening' {
  return hour < 6 ? 'morning' : 'evening';
}

async function triggerSlot(env: Env, slot: 'morning' | 'evening'): Promise<{ ok: boolean; status: number; body: string }> {
  const controller = new AbortController();
  // Cold start + a 4-cell serial slot can take a few minutes. Cap generously;
  // the slot ledger makes the next fire a safe resume if this times out.
  const timer = setTimeout(() => controller.abort(), 8 * 60 * 1000);
  try {
    const res = await fetch(env.SCHEDULE_TRIGGER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SCHEDULE_TRIGGER_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ slot }),
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
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const firedAt = new Date(event.scheduledTime);
    const hour = firedAt.getUTCHours();
    const slot = slotForUtcHour(hour);
    const result = await triggerSlot(env, slot);
    console.log(`slot trigger ${slot}: ok=${result.ok} status=${result.status} body=${result.body}`);
    if (!result.ok) {
      // Throw so Cloudflare marks the invocation failed; its automatic retry and
      // the optional GitHub watchdog both re-POST an idempotent trigger.
      throw new Error(`slot ${slot} trigger failed: ${result.status} ${result.body}`);
    }
  },

  // Manual smoke test: `curl https://<worker>.workers.dev/__sched?slot=morning`
  // with the same bearer token (useful without touching the real schedule).
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/__sched') {
      const auth = req.headers.get('Authorization') ?? '';
      if (auth !== `Bearer ${env.SCHEDULE_TRIGGER_TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      const slot = url.searchParams.get('slot') === 'evening' ? 'evening' : 'morning';
      const result = await triggerSlot(env, slot);
      return new Response(JSON.stringify({ slot, ...result }), {
        status: result.ok ? 200 : 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('pixivflow slot clock', { status: 200 });
  },
};
