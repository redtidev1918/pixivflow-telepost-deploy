import { describe, expect, it } from 'vitest';

import { dueForDispatch, pastDeadline, reconcile } from '../src/reconciliation';
import { SCHEDULES } from '../src/schedules';
import type { Occurrence } from '../src/occurrences';
import type {
  ControlStore,
  EventRecord,
  OccurrenceRow,
  ReconciliationSummary,
  SlotStatus,
} from '../src/store';

/** In-memory ControlStore: the state machine is tested without emulating D1. */
class MemoryStore implements ControlStore {
  readonly rows = new Map<string, OccurrenceRow>();
  readonly events: EventRecord[] = [];
  readonly runs: ReconciliationSummary[] = [];
  private inserted = 0;

  async insertOccurrenceIfAbsent(occurrence: Occurrence, nowMs: number): Promise<'created' | 'exists'> {
    if (this.rows.has(occurrence.slotId)) return 'exists';
    this.inserted += 1;
    this.rows.set(occurrence.slotId, {
      id: occurrence.slotId,
      scheduleId: occurrence.scheduleId,
      botId: occurrence.botId,
      occurrenceAt: occurrence.occurrenceAt,
      status: 'pending',
      attemptCount: 0,
      dispatchDeadline: occurrence.dispatchDeadline,
      currentExecutionId: null,
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
    });
    return 'created';
  }

  async listActiveOccurrences(fromMs: number, toMs: number): Promise<OccurrenceRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          !['success', 'partial', 'failed', 'cancelled', 'expired'].includes(row.status) &&
          row.occurrenceAt >= fromMs &&
          row.occurrenceAt <= toMs
      )
      .sort((a, b) => a.occurrenceAt - b.occurrenceAt);
  }

  async listRecentOccurrences(limit: number): Promise<OccurrenceRow[]> {
    return [...this.rows.values()].sort((a, b) => b.occurrenceAt - a.occurrenceAt).slice(0, limit);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.rows.values()) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }

  async markExpired(slotId: string, reason: string, nowMs: number): Promise<void> {
    const row = this.rows.get(slotId);
    if (!row) throw new Error(`unknown slot ${slotId}`);
    row.status = 'expired';
    row.completedAt = nowMs;
    row.lastError = reason;
  }

  async recordReconciliation(input: { summary: ReconciliationSummary }): Promise<void> {
    this.runs.push(input.summary);
  }

  async logEvents(events: EventRecord[]): Promise<void> {
    this.events.push(...events);
  }

  /** Test helper: total rows ever created (rows are never deleted here). */
  get createdCount(): number {
    return this.inserted;
  }

  setStatus(slotId: string, status: SlotStatus): void {
    const row = this.rows.get(slotId);
    if (!row) throw new Error(`unknown slot ${slotId}`);
    row.status = status;
  }
}

const maxAttemptsFor = (scheduleId: string): number =>
  SCHEDULES.find((s) => s.id === scheduleId)?.maxAttempts ?? 3;

describe('reconciliation creates what a lost tick never created', () => {
  it('creates every occurrence of the lookback window and is idempotent', async () => {
    const store = new MemoryStore();
    // 19:00 Shanghai: the 18:00 and 18:10 ticks already passed.
    const now = Date.parse('2026-09-11T11:00:00Z');

    const first = await reconcile(store, SCHEDULES, now, { lookbackHours: 24 });
    expect(first.created).toBe(4); // 09-11 10:00, 10:10, 18:00, 18:10 local
    expect([...store.rows.keys()].sort()).toEqual([
      'bot1-daily@2026-09-11T1000',
      'bot1-daily@2026-09-11T1800',
      'bot2-daily@2026-09-11T1010',
      'bot2-daily@2026-09-11T1810',
    ]);

    // A second sweep (e.g. the next 10-minute tick) must change nothing.
    const second = await reconcile(store, SCHEDULES, now + 60_000, { lookbackHours: 24 });
    expect(second.created).toBe(0);
    expect(store.createdCount).toBe(4);
  });

  it('recovers an occurrence whose tick was lost, on the next sweep', async () => {
    const store = new MemoryStore();
    const beforeEvening = Date.parse('2026-09-11T09:50:00Z'); // 17:50 Shanghai
    await reconcile(store, SCHEDULES, beforeEvening, { lookbackHours: 24 });
    expect(store.rows.has('bot1-daily@2026-09-11T1800')).toBe(false);

    // The 18:00 tick never fired. The sweep at 18:20 still creates the slot.
    const afterEvening = Date.parse('2026-09-11T10:20:00Z'); // 18:20 Shanghai
    const summary = await reconcile(store, SCHEDULES, afterEvening, { lookbackHours: 24 });
    expect(summary.created).toBe(2); // bot1 18:00 + bot2 18:10
    expect(store.rows.has('bot1-daily@2026-09-11T1800')).toBe(true);
    expect(store.rows.has('bot2-daily@2026-09-11T1810')).toBe(true);
  });

  it('logs occurrence_created with the canonical identity', async () => {
    const store = new MemoryStore();
    await reconcile(store, SCHEDULES, Date.parse('2026-09-11T11:00:00Z'), { lookbackHours: 24 });
    const created = store.events.filter((e) => e.event === 'occurrence_created');
    expect(created).toHaveLength(4);
    const bot1Evening = created.find((e) => e.slotId === 'bot1-daily@2026-09-11T1800');
    expect(bot1Evening?.scheduleId).toBe('bot1-daily');
    expect(bot1Evening?.botId).toBe('bot1');
    expect(JSON.parse(bot1Evening!.detail!)).toMatchObject({
      occurrenceAt: Date.parse('2026-09-11T10:00:00Z'),
      occurrenceLabel: '18:00',
      timezone: 'Asia/Shanghai',
    });
  });
});

describe('business deadline is separate from reliability', () => {
  it('expires an occurrence instead of publishing stale content', async () => {
    const store = new MemoryStore();
    // A long outage: reconciliation only resumes at 04:00 Shanghai the next day.
    const now = Date.parse('2026-09-11T20:00:00Z');
    const summary = await reconcile(store, SCHEDULES, now, { lookbackHours: 24 });

    // Everything in the window is already past its 6h dispatch deadline.
    expect(summary.created).toBe(4);
    expect(summary.expired).toBe(4);
    expect([...store.rows.values()].every((row) => row.status === 'expired')).toBe(true);
    expect(store.events.some((e) => e.event === 'slot_terminal')).toBe(true);
  });

  it('does not expire an occurrence that is still inside its deadline', async () => {
    const store = new MemoryStore();
    const now = Date.parse('2026-09-11T11:00:00Z'); // 19:00 Shanghai
    // A lookback shorter than the deadline: the window only holds the 18:00 and
    // 18:10 occurrences (18:00 local == 10:00Z), both well inside 6h.
    const summary = await reconcile(store, SCHEDULES, now, { lookbackHours: 3 });
    expect(summary.created).toBe(2);
    expect(summary.expired).toBe(0);
    expect([...store.rows.values()].every((row) => row.status === 'pending')).toBe(true);
  });

  it('expires only what is genuinely past its deadline', async () => {
    const store = new MemoryStore();
    const now = Date.parse('2026-09-11T11:00:00Z');
    const summary = await reconcile(store, SCHEDULES, now, { lookbackHours: 24 });
    // 10:00/10:10 local (02:00Z/02:10Z) are past their 6h deadline by 19:00 local;
    // the 18:00/18:10 pair is not.
    expect(summary.expired).toBe(2);
    expect(store.rows.get('bot1-daily@2026-09-11T1000')!.status).toBe('expired');
    expect(store.rows.get('bot1-daily@2026-09-11T1800')!.status).toBe('pending');
  });

  it('never resurrects a terminal slot', async () => {
    const store = new MemoryStore();
    const now = Date.parse('2026-09-11T11:00:00Z');
    await reconcile(store, SCHEDULES, now, { lookbackHours: 24 });
    store.setStatus('bot1-daily@2026-09-11T1800', 'success');

    const later = Date.parse('2026-09-11T20:00:00Z'); // everything is past deadline
    const summary = await reconcile(store, SCHEDULES, later, { lookbackHours: 24 });

    // The successful occurrence keeps its terminal state and is not re-created.
    expect(store.rows.get('bot1-daily@2026-09-11T1800')!.status).toBe('success');
    expect(summary.created).toBe(0);
    // The sibling that never finished is still converged: by 20:00Z it is past
    // its own deadline, so it expires rather than being dispatched late.
    expect(summary.expired).toBe(1);
    expect(store.rows.get('bot2-daily@2026-09-11T1810')!.status).toBe('expired');
    expect(store.createdCount).toBe(4);
  });
});

describe('dispatch eligibility rules', () => {
  const row = (overrides: Partial<OccurrenceRow> = {}): OccurrenceRow => ({
    id: 'bot1-daily@2026-09-11T1800',
    scheduleId: 'bot1-daily',
    botId: 'bot1',
    occurrenceAt: 0,
    status: 'pending',
    attemptCount: 0,
    dispatchDeadline: 1000,
    currentExecutionId: null,
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
    lastError: null,
    ...overrides,
  });

  it('dispatches pending occurrences inside the deadline', () => {
    expect(dueForDispatch([row()], 500, maxAttemptsFor).map((r) => r.id)).toEqual([row().id]);
  });

  it('does not dispatch an occurrence past its deadline', () => {
    expect(dueForDispatch([row()], 1001, maxAttemptsFor)).toHaveLength(0);
    expect(pastDeadline([row()], 1001).map((r) => r.id)).toEqual([row().id]);
  });

  it('does not dispatch a terminal occurrence', () => {
    for (const status of ['success', 'partial', 'failed', 'cancelled', 'expired'] as const) {
      expect(dueForDispatch([row({ status })], 500, maxAttemptsFor)).toHaveLength(0);
    }
  });

  it('stops after the configured attempts', () => {
    expect(dueForDispatch([row({ attemptCount: 3 })], 500, maxAttemptsFor)).toHaveLength(0);
    expect(dueForDispatch([row({ attemptCount: 2 })], 500, maxAttemptsFor)).toHaveLength(1);
  });

  it('never re-dispatches a row whose runner may still be alive', () => {
    // `dispatched`/`running`/`uncertain` are decided by the execution provider
    // (or by an explicit operator decision), never by this filter: re-dispatching
    // a live runner is how a duplicate post happens.
    for (const status of ['dispatched', 'running', 'uncertain'] as const) {
      expect(dueForDispatch([row({ status })], 500, maxAttemptsFor)).toHaveLength(0);
    }
    // An explicit retry path exists: the caller reconciles the provider run and
    // returns the row to `pending`, which is dispatchable again while attempts
    // remain.
    expect(dueForDispatch([row({ status: 'pending', attemptCount: 1 })], 500, maxAttemptsFor)).toHaveLength(1);
  });
});
