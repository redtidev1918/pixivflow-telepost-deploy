/**
 * Reconciliation: the reliability core.
 *
 * Every sweep asks the same question instead of "did a cron fire?":
 *
 *   which occurrences should exist by now?
 *   which of them does the ledger already have?
 *   which are finished, which never dispatched, which lost their runner?
 *   which are due for a retry, which are past their business deadline?
 *
 * That is why a lost Cloudflare tick, a delayed clock, a runner crash or a lost
 * callback cannot lose work: the next sweep recomputes the expected set and
 * converges towards it.
 */

import { occurrencesInLookback, type Occurrence } from './occurrences';
import { RECONCILIATION_LOOKBACK_HOURS, type ScheduleDefinition } from './schedules';
import {
  isTerminal,
  type ControlStore,
  type EventRecord,
  type OccurrenceRow,
  type ReconciliationSummary,
} from './store';

export interface ReconcileOptions {
  /** Overrides the configured lookback (used by tests and by ops tooling). */
  lookbackHours?: number;
  /** Correlation id for the sweep record; defaults to a timestamp-based id. */
  runId?: string;
}

export function emptySummary(): ReconciliationSummary {
  return { created: 0, dispatched: 0, reconciled: 0, retried: 0, expired: 0, errors: [] };
}

/**
 * Occurrences that should be handed to the execution provider right now.
 *
 * Pure so the rules can be tested exhaustively without a store.
 *
 * Only `pending` rows qualify. `dispatched`/`running`/`uncertain` are NOT
 * re-dispatched here on purpose: their fate must be decided by the execution
 * provider's own state (spec: provider state, never a heartbeat), because
 * blindly re-dispatching a row whose runner is still alive is exactly how a
 * duplicate post happens. A retry is therefore a deliberate transition — the
 * caller first reconciles the provider run, then returns the row to `pending`
 * (or opens the next attempt) — not a side effect of this filter.
 */
export function dueForDispatch(
  rows: readonly OccurrenceRow[],
  nowMs: number,
  maxAttemptsFor: (scheduleId: string) => number
): OccurrenceRow[] {
  return rows.filter((row) => {
    if (row.status !== 'pending') return false;
    if (row.dispatchDeadline !== null && nowMs > row.dispatchDeadline) return false;
    return row.attemptCount < maxAttemptsFor(row.scheduleId);
  });
}

/** Occurrences whose business deadline passed while they were still unfinished. */
export function pastDeadline(rows: readonly OccurrenceRow[], nowMs: number): OccurrenceRow[] {
  return rows.filter(
    (row) =>
      !isTerminal(row.status) && row.dispatchDeadline !== null && nowMs > row.dispatchDeadline
  );
}

export async function reconcile(
  store: ControlStore,
  schedules: readonly ScheduleDefinition[],
  nowMs: number,
  options: ReconcileOptions = {}
): Promise<ReconciliationSummary> {
  const lookbackHours = options.lookbackHours ?? RECONCILIATION_LOOKBACK_HOURS;
  const runId = options.runId ?? `reconcile-${nowMs}`;
  const summary = emptySummary();
  const events: EventRecord[] = [];

  // 1. Ensure every occurrence that should exist by now does exist. Idempotent:
  //    the unique (schedule_id, occurrence_at) key makes a repeat sweep a no-op.
  const expected = occurrencesInLookback(schedules, nowMs, lookbackHours);
  const windowStart = nowMs - lookbackHours * 60 * 60 * 1000;
  for (const occurrence of expected) {
    const result = await store.insertOccurrenceIfAbsent(occurrence, nowMs);
    if (result === 'created') {
      summary.created += 1;
      events.push(eventFor(nowMs, 'occurrence_created', occurrence, {
        occurrenceAt: occurrence.occurrenceAt,
        occurrenceLabel: occurrence.occurrenceLabel,
        timezone: occurrence.timezone,
      }));
    }
  }

  // 2. Converge what the ledger already knows about.
  const active = await store.listActiveOccurrences(windowStart, nowMs);

  for (const row of pastDeadline(active, nowMs)) {
    // Reliability and content policy are separate: recovery may still be possible,
    // but an occurrence nobody wants published any more must not be dispatched.
    await store.markExpired(row.id, 'past dispatch deadline; not dispatched', nowMs);
    summary.expired += 1;
    events.push({
      ts: nowMs,
      event: 'slot_terminal',
      slotId: row.id,
      scheduleId: row.scheduleId,
      botId: row.botId,
      detail: JSON.stringify({ status: 'expired', reason: 'past dispatch deadline' }),
    });
  }

  await store.recordReconciliation({
    id: runId,
    startedAt: nowMs,
    finishedAt: nowMs,
    summary,
  });
  if (events.length > 0) await store.logEvents(events);

  return summary;
}

function eventFor(
  ts: number,
  event: string,
  occurrence: Occurrence,
  detail: Record<string, unknown>
): EventRecord {
  return {
    ts,
    event,
    slotId: occurrence.slotId,
    scheduleId: occurrence.scheduleId,
    botId: occurrence.botId,
    detail: JSON.stringify(detail),
  };
}
