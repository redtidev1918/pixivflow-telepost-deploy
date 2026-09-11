/**
 * Deployment glue: the only thing this Worker knows about the domain.
 *
 * One cron string in, one schedule id out. Nothing else.
 *
 * The Worker deliberately does NOT:
 *   - compute occurrences (that is PixivFlow's durable slot ledger),
 *   - convert timezones at runtime (the shift below is applied once, by hand),
 *   - generate slot ids, or write any business table.
 *
 * Cloudflare cron expressions are UTC. The schedules themselves are declared in
 * Asia/Shanghai in `pixivflow/config/production.json` (bot1-daily at 10:00/18:00,
 * bot2-daily at 10:10/18:10), so each expression below is that schedule's local
 * time minus eight hours. Doing the shift here - once, statically - is what lets
 * the clock stay free of date arithmetic: if it ever needs a calendar, it has
 * grown back into a control plane.
 *
 * `control-plane/test/deployment-contract.test.ts` fails if these keys and the
 * `[triggers] crons` list in wrangler.toml drift apart.
 */
export interface CronBinding {
  /** Schedule id understood by PixivFlow's trigger endpoint. */
  scheduleId: string;
  /** Human-readable provenance for logs. Never parsed. */
  label: string;
}

export const CRON_MAP: Record<string, CronBinding> = {
  '0 2,10 * * *': {
    scheduleId: 'bot1-daily',
    label: 'bot1-daily 10:00/18:00 Asia/Shanghai',
  },
  '10 2,10 * * *': {
    scheduleId: 'bot2-daily',
    label: 'bot2-daily 10:10/18:10 Asia/Shanghai',
  },
};

/** Every expression that must appear verbatim in wrangler.toml `[triggers] crons`. */
export const CRONS: string[] = Object.keys(CRON_MAP);

export function bindingFor(cron: string): CronBinding | undefined {
  return CRON_MAP[cron.trim()];
}
