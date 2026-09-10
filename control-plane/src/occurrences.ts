/**
 * Canonical occurrence identity.
 *
 * An occurrence's identity comes ONLY from the schedule's own clock: its times,
 * its timezone, and the canonical scheduled instant. Never from `Date.now()`, the
 * runner's start time, a local date, or a client-supplied string — that is what
 * made the old system produce "18:27" style identities and lose the occurrence
 * the moment a run started late.
 *
 *   bot1-daily@2026-09-11T1800  (+08:00)  ==  2026-09-11T10:00:00Z
 *
 * Running it at 18:27 is still the 18:00 occurrence, and every retry reuses it.
 */

import { RECONCILIATION_LOOKBACK_HOURS, ScheduleDefinition } from './schedules';

export interface Occurrence {
  /** `<scheduleId>@<local date>T<HHMM>` — the D1 primary key. */
  slotId: string;
  scheduleId: string;
  botId: string;
  /** Epoch ms of the canonical instant. */
  occurrenceAt: number;
  /** Schedule-local date, e.g. 2026-09-11. */
  occurrenceDate: string;
  /** Schedule-local wall-clock label, e.g. 18:00. */
  occurrenceLabel: string;
  timezone: string;
  /** Epoch ms after which this occurrence must no longer be dispatched. */
  dispatchDeadline: number;
}

const pad = (value: number): string => String(value).padStart(2, '0');

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function partsInZone(instantMs: number, timeZone: string): ZoneParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  // formatToParts always emits these fields; reading them through a helper keeps
  // the absence explicit instead of silently producing NaN dates.
  const read = (field: string): number => {
    const value = parts[field];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`timezone ${timeZone}: missing ${field} for instant ${instantMs}`);
    }
    return value;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Offset of `timeZone` at `instantMs`, in milliseconds (east positive). */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const p = partsInZone(instantMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round(asUtc / 1000) * 1000 - Math.round(instantMs / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `timeZone` reads `date` `time`.
 *
 * Two passes: guess using the offset at the naive instant, then re-check, which
 * resolves the offset on the far side of a DST transition.
 */
/** Parse `YYYY-MM-DD`, failing loudly instead of yielding NaN dates. */
function parseDate(date: string): { year: number; month: number; day: number } {
  const parts = date.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`invalid date: ${date}`);
  }
  return { year, month, day };
}

function parseTime(time: string): { hour: number; minute: number } {
  const parts = time.split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`invalid time: ${time}`);
  }
  return { hour, minute };
}

export function zonedTimeToInstant(date: string, time: string, timeZone: string): number {
  const { year, month, day } = parseDate(date);
  const { hour, minute } = parseTime(time);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = zoneOffsetMs(naive, timeZone);
  let instant = naive - firstOffset;
  const secondOffset = zoneOffsetMs(instant, timeZone);
  if (secondOffset !== firstOffset) instant = naive - secondOffset;
  return instant;
}

/** Schedule-local date/time for an instant, used to label occurrences. */
export function instantToLocal(instantMs: number, timeZone: string): { date: string; time: string } {
  const p = partsInZone(instantMs, timeZone);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

export function slotIdFor(scheduleId: string, localDate: string, localTime: string): string {
  return `${scheduleId}@${localDate}T${localTime.replace(':', '')}`;
}

/** The canonical occurrence for one schedule at one local date + time. */
export function occurrenceFor(
  schedule: ScheduleDefinition,
  localDate: string,
  localTime: string
): Occurrence {
  const occurrenceAt = zonedTimeToInstant(localDate, localTime, schedule.timezone);
  return {
    slotId: slotIdFor(schedule.id, localDate, localTime),
    scheduleId: schedule.id,
    botId: schedule.botId,
    occurrenceAt,
    occurrenceDate: localDate,
    occurrenceLabel: localTime,
    timezone: schedule.timezone,
    dispatchDeadline: occurrenceAt + schedule.dispatchDeadlineHours * 60 * 60 * 1000,
  };
}

function shiftDate(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * Every occurrence that exists between `fromMs` and `toMs`, inclusive.
 *
 * Reconciliation asks this question instead of trusting a one-shot cron: a lost
 * clock tick changes nothing, because the next sweep recomputes the same set and
 * creates whatever is missing.
 */
export function expectedOccurrences(
  schedules: readonly ScheduleDefinition[],
  fromMs: number,
  toMs: number
): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const schedule of schedules) {
    const startDate = instantToLocal(fromMs, schedule.timezone).date;
    const endDate = instantToLocal(toMs, schedule.timezone).date;
    // One extra day on each side so a timezone edge cannot clip an occurrence.
    for (let date = shiftDate(startDate, -1); date <= shiftDate(endDate, 1); date = shiftDate(date, 1)) {
      for (const time of schedule.times) {
        const occurrence = occurrenceFor(schedule, date, time);
        if (occurrence.occurrenceAt >= fromMs && occurrence.occurrenceAt <= toMs) {
          occurrences.push(occurrence);
        }
      }
    }
  }
  return occurrences.sort((a, b) => a.occurrenceAt - b.occurrenceAt);
}

/**
 * The occurrences reconciliation should currently care about: everything from the
 * lookback horizon up to (and including) now.
 *
 * A wider horizon than the old 120-minute HTTP grace window is the point: a
 * missed tick is compensated instead of losing the day's work.
 */
export function occurrencesInLookback(
  schedules: readonly ScheduleDefinition[],
  nowMs: number,
  lookbackHours: number = RECONCILIATION_LOOKBACK_HOURS
): Occurrence[] {
  return expectedOccurrences(schedules, nowMs - lookbackHours * 60 * 60 * 1000, nowMs);
}

/** The next occurrence strictly after `nowMs` (for /status and observability). */
export function nextOccurrence(
  schedules: readonly ScheduleDefinition[],
  nowMs: number
): Occurrence | null {
  const horizon = nowMs + 48 * 60 * 60 * 1000;
  const upcoming = expectedOccurrences(schedules, nowMs + 1, horizon);
  return upcoming.length > 0 ? upcoming[0]! : null;
}
