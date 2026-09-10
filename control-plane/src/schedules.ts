/**
 * Schedule configuration as code.
 *
 * Non-secret production schedule state is versioned here rather than seeded into
 * D1 by hand: what the fleet is supposed to run is reviewed like any other code
 * change, while D1 only tracks what actually happened.
 *
 * `times` are wall-clock times in `timezone`; the canonical occurrence instant is
 * derived from them (see occurrences.ts). Keeping times+timezone instead of a
 * cron string is deliberate — every production schedule is a fixed daily clock,
 * and an unsupported cron expression should fail loudly at load, not silently
 * resolve to the wrong occurrence.
 */

export type WorkType = 'illustration' | 'novel';

export interface ScheduleTarget {
  id: string;
  workType: WorkType;
}

export interface ScheduleDefinition {
  id: string;
  botId: string;
  /** Local "HH:MM" wall-clock times, e.g. "10:00" / "18:00". */
  times: string[];
  timezone: string;
  targets: ScheduleTarget[];
  /**
   * Business deadline: an occurrence older than this is never dispatched again
   * (it becomes `expired`). Reliability and content policy are separate concerns
   * — recovery may still be possible long after a slot stopped being wanted.
   */
  dispatchDeadlineHours: number;
  /** Total dispatch attempts allowed for one occurrence, retries included. */
  maxAttempts: number;
}

/** How far back reconciliation looks for occurrences it should have created. */
export const RECONCILIATION_LOOKBACK_HOURS = 24;

/** Attempts are not retried endlessly: a failing provider must be visible. */
export const DEFAULT_MAX_ATTEMPTS = 3;

export const SCHEDULES: ScheduleDefinition[] = [
  {
    id: 'bot1-daily',
    botId: 'bot1',
    times: ['10:00', '18:00'],
    timezone: 'Asia/Shanghai',
    targets: [
      { id: 'bot1-illust-botefuku', workType: 'illustration' },
      { id: 'bot1-novel-botefuku', workType: 'novel' },
    ],
    dispatchDeadlineHours: 6,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  },
  {
    id: 'bot2-daily',
    botId: 'bot2',
    times: ['10:10', '18:10'],
    timezone: 'Asia/Shanghai',
    targets: [
      { id: 'bot2-illust-marunomi', workType: 'illustration' },
      { id: 'bot2-novel-marunomi', workType: 'novel' },
    ],
    dispatchDeadlineHours: 6,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  },
];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Validate the whole table once, so a bad edit cannot silently skip a schedule. */
export function validateSchedules(schedules: readonly ScheduleDefinition[] = SCHEDULES): void {
  const seenIds = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule.id) throw new Error('schedule id is required');
    if (seenIds.has(schedule.id)) throw new Error(`duplicate schedule id: ${schedule.id}`);
    seenIds.add(schedule.id);
    if (schedule.times.length === 0) throw new Error(`schedule ${schedule.id} has no times`);
    for (const time of schedule.times) {
      if (!TIME_RE.test(time)) {
        throw new Error(`schedule ${schedule.id}: time "${time}" must be HH:MM (24h)`);
      }
    }
    if (schedule.targets.length === 0) {
      throw new Error(`schedule ${schedule.id} has no targets`);
    }
    if (!Number.isInteger(schedule.maxAttempts) || schedule.maxAttempts < 1) {
      throw new Error(`schedule ${schedule.id}: maxAttempts must be a positive integer`);
    }
    if (!(schedule.dispatchDeadlineHours > 0)) {
      throw new Error(`schedule ${schedule.id}: dispatchDeadlineHours must be positive`);
    }
  }
}

export function schedulesById(
  schedules: readonly ScheduleDefinition[] = SCHEDULES
): Map<string, ScheduleDefinition> {
  return new Map(schedules.map((schedule) => [schedule.id, schedule]));
}
