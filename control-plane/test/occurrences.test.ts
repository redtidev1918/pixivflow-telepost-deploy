import { describe, expect, it } from 'vitest';

import {
  expectedOccurrences,
  instantToLocal,
  nextOccurrence,
  occurrenceFor,
  occurrencesInLookback,
  slotIdFor,
  zonedTimeToInstant,
} from '../src/occurrences';
import { SCHEDULES, validateSchedules } from '../src/schedules';

const bot1 = SCHEDULES.find((s) => s.id === 'bot1-daily')!;
const bot2 = SCHEDULES.find((s) => s.id === 'bot2-daily')!;

describe('canonical occurrence identity', () => {
  it('derives the instant from the schedule clock, not from "now"', () => {
    // 18:00 Asia/Shanghai (+08:00) == 10:00Z the same day.
    expect(zonedTimeToInstant('2026-09-11', '18:00', 'Asia/Shanghai')).toBe(
      Date.parse('2026-09-11T10:00:00Z')
    );
    expect(zonedTimeToInstant('2026-09-11', '10:00', 'Asia/Shanghai')).toBe(
      Date.parse('2026-09-11T02:00:00Z')
    );
  });

  it('keeps the existing production slot-id convention', () => {
    // The 2026-09-10 evening occurrence from the incident must keep its id, so
    // the ledger stays comparable across the migration.
    const occurrence = occurrenceFor(bot1, '2026-09-10', '18:00');
    expect(occurrence.slotId).toBe('bot1-daily@2026-09-10T1800');
    expect(occurrence.occurrenceAt).toBe(Date.parse('2026-09-10T10:00:00Z'));
    expect(occurrence.botId).toBe('bot1');
  });

  it('labels an occurrence in the schedule timezone', () => {
    expect(instantToLocal(Date.parse('2026-09-11T10:00:00Z'), 'Asia/Shanghai')).toEqual({
      date: '2026-09-11',
      time: '18:00',
    });
  });

  it('resolves wall-clock times across a DST transition', () => {
    // US DST starts 2026-03-08: 09:00 is EST (-5) before, EDT (-4) after.
    expect(zonedTimeToInstant('2026-03-07', '09:00', 'America/New_York')).toBe(
      Date.parse('2026-03-07T14:00:00Z')
    );
    expect(zonedTimeToInstant('2026-03-08', '09:00', 'America/New_York')).toBe(
      Date.parse('2026-03-08T13:00:00Z')
    );
  });
});

describe('reconciliation set', () => {
  it('enumerates every occurrence in a window, for every schedule', () => {
    const now = Date.parse('2026-09-11T11:00:00Z'); // 19:00 Shanghai
    // 24h back from 11:00Z starts at 2026-09-10T11:00Z (09-10 19:00 local), so
    // 09-10's own slots are already outside the window while both of 09-11's
    // (morning 10:00/10:10 local and evening 18:00/18:10 local) are inside.
    const occurrences = occurrencesInLookback(SCHEDULES, now, 24);
    expect(occurrences.map((o) => o.slotId)).toEqual([
      'bot1-daily@2026-09-11T1000',
      'bot2-daily@2026-09-11T1010',
      'bot1-daily@2026-09-11T1800',
      'bot2-daily@2026-09-11T1810',
    ]);
  });

  it('covers two local days when the window spans them', () => {
    const now = Date.parse('2026-09-11T14:00:00Z'); // 22:00 Shanghai
    const ids = occurrencesInLookback(SCHEDULES, now, 36).map((o) => o.slotId);
    expect(ids).toEqual([
      'bot1-daily@2026-09-10T1000',
      'bot2-daily@2026-09-10T1010',
      'bot1-daily@2026-09-10T1800',
      'bot2-daily@2026-09-10T1810',
      'bot1-daily@2026-09-11T1000',
      'bot2-daily@2026-09-11T1010',
      'bot1-daily@2026-09-11T1800',
      'bot2-daily@2026-09-11T1810',
    ]);
  });

  it('finds a missed occurrence from an earlier tick (a lost cron changes nothing)', () => {
    // The 18:00 tick is lost; a later sweep at 18:20 still reports both evening
    // occurrences, so reconciliation creates whatever is missing.
    const later = Date.parse('2026-09-10T10:20:00Z'); // 18:20 Shanghai
    const ids = occurrencesInLookback(SCHEDULES, later).map((o) => o.slotId);
    expect(ids).toContain('bot1-daily@2026-09-10T1800');
    expect(ids).toContain('bot2-daily@2026-09-10T1810');
  });

  it('never reports an occurrence that has not happened yet', () => {
    const now = Date.parse('2026-09-11T09:00:00Z'); // 17:00 Shanghai
    const ids = occurrencesInLookback(SCHEDULES, now).map((o) => o.slotId);
    expect(ids).not.toContain('bot1-daily@2026-09-11T1800');
  });

  it('carries the per-schedule dispatch deadline', () => {
    const occurrence = occurrenceFor(bot1, '2026-09-11', '18:00');
    expect(occurrence.dispatchDeadline).toBe(
      occurrence.occurrenceAt + bot1.dispatchDeadlineHours * 60 * 60 * 1000
    );
  });

  it('reports the next occurrence and stays consistent with enumeration', () => {
    const now = Date.parse('2026-09-11T11:00:00Z'); // 19:00 Shanghai
    const next = nextOccurrence(SCHEDULES, now);
    // After 19:00 local, the next slot is the following morning's 10:00.
    expect(next?.slotId).toBe('bot1-daily@2026-09-12T1000');
    expect(next!.occurrenceAt).toBe(Date.parse('2026-09-12T02:00:00Z'));
    // The next occurrence must be strictly in the future.
    expect(next!.occurrenceAt).toBeGreaterThan(now);
    expect(expectedOccurrences(SCHEDULES, now + 1, next!.occurrenceAt).map((o) => o.slotId)).toEqual([
      next!.slotId,
    ]);
  });

  it('slotIdFor is stable and collision-free across schedules', () => {
    expect(slotIdFor('bot1-daily', '2026-09-11', '18:00')).toBe('bot1-daily@2026-09-11T1800');
    expect(slotIdFor('bot2-daily', '2026-09-11', '18:10')).not.toBe(
      slotIdFor('bot1-daily', '2026-09-11', '18:00')
    );
  });
});

describe('schedule config as code', () => {
  it('validates the production table', () => {
    expect(() => validateSchedules(SCHEDULES)).not.toThrow();
  });

  it('rejects a malformed time instead of silently skipping the schedule', () => {
    expect(() =>
      validateSchedules([{ ...bot1, times: ['18:0'] }])
    ).toThrow(/must be HH:MM/);
  });

  it('rejects duplicate schedule ids and empty targets', () => {
    expect(() => validateSchedules([bot1, { ...bot2, id: bot1.id }])).toThrow(/duplicate schedule id/);
    expect(() => validateSchedules([{ ...bot1, targets: [] }])).toThrow(/no targets/);
  });

  it('keeps bot1 and bot2 on their own times (isolation is data-driven)', () => {
    expect(bot1.times).toEqual(['10:00', '18:00']);
    expect(bot2.times).toEqual(['10:10', '18:10']);
    expect(bot1.botId).not.toBe(bot2.botId);
  });
});
