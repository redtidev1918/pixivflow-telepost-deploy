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
 * ## Two clocks, one schedule set
 *
 * Production runs TWO independent external clocks over the same schedules:
 *
 *   PRIMARY    cron-job.org      fires AT the occurrence
 *   SECONDARY  this Worker       fires at the occurrence + SECONDARY_OFFSET_MINUTES
 *
 * Both POST the same authenticated, idempotent trigger. Neither owns state, and
 * neither computes an occurrence. Whichever arrives second converges on the slot
 * the first one created, because PixivFlow's durable slot ledger is the single
 * execution authority. That is what makes a redundant clock safe rather than a
 * second scheduler.
 *
 * Why a second clock exists at all: a single clock cannot report that IT never
 * ran. On 2026-09-13 the 10:00/10:10 CST occurrences were silently missed and
 * nothing in the system could tell "the batch had nothing to post" apart from
 * "the clock never fired". See docs/incidents/.
 *
 * Cloudflare cron expressions are UTC. The schedules themselves are declared in
 * Asia/Shanghai in `pixivflow/config/production.json` (bot1-daily at 10:00/22:00,
 * bot2-daily at 10:10/22:10), so each expression below is that schedule's local
 * time minus eight hours, plus the secondary offset.
 *
 * `deployment-contract.test.ts` fails if these keys and the `[triggers] crons`
 * list in wrangler.toml drift apart; `redundant-clock.test.ts` fails if the
 * primary/secondary relationship stops holding.
 */
export interface CronBinding {
  /** Schedule id understood by PixivFlow's trigger endpoint. */
  scheduleId: string;
  /** Human-readable provenance for logs. Never parsed. */
  label: string;
  /** Which clock this expression belongs to. */
  clockRole: 'primary' | 'secondary';
  /**
   * The PRIMARY clock's expression for the same schedule.
   *
   * Metadata only: this Worker never reads it to decide anything. It exists so
   * "the secondary is the primary plus the documented offset" is machine-checked
   * rather than asserted in prose, and so the operator can read both halves of
   * the redundancy from one place.
   */
  primaryCron: string;
}

/**
 * How far behind the primary the secondary fires, in minutes.
 *
 * Proven against PixivFlow's real occurrence resolver in
 * `PixivFlow/src/__tests__/scheduler/redundantClockOffset.test.ts`: at this
 * offset both clocks resolve to the SAME occurrence, and the binding bound is the
 * 15-minute lead window (a delay of 704+ minutes would silently name the NEXT
 * occurrence instead).
 */
export const SECONDARY_OFFSET_MINUTES = 2;

export const CRON_MAP: Record<string, CronBinding> = {
  '2 2,14 * * *': {
    scheduleId: 'bot1-daily',
    label: 'bot1-daily 10:00/22:00 Asia/Shanghai (secondary clock, +2 min)',
    clockRole: 'secondary',
    primaryCron: '0 2,14 * * *',
  },
  '12 2,14 * * *': {
    scheduleId: 'bot2-daily',
    label: 'bot2-daily 10:10/22:10 Asia/Shanghai (secondary clock, +2 min)',
    clockRole: 'secondary',
    primaryCron: '10 2,14 * * *',
  },
};

/** Every expression that must appear verbatim in wrangler.toml `[triggers] crons`. */
export const CRONS: string[] = Object.keys(CRON_MAP);

/**
 * The expressions the PRIMARY clock (cron-job.org) must be configured with.
 *
 * Exported so the operator-facing runbook and the contract test read the same
 * list. This Worker never registers them: cron-job.org is a separate provider in
 * a separate failure domain, which is the entire point of having two.
 */
export const PRIMARY_CRONS: string[] = [...new Set(Object.values(CRON_MAP).map((b) => b.primaryCron))];

export function bindingFor(cron: string): CronBinding | undefined {
  return CRON_MAP[cron.trim()];
}

/** The binding for a schedule id, from the Worker's own (secondary) map. */
export function bindingForSchedule(scheduleId: string): CronBinding | undefined {
  return Object.values(CRON_MAP).find((binding) => binding.scheduleId === scheduleId);
}
