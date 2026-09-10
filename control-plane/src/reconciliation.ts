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
import { reconcileExecution, startAttempt } from './execution';
import type { ExecutionProvider } from './provider';
import { RECONCILIATION_LOOKBACK_HOURS, type ScheduleDefinition } from './schedules';
import {
  isTerminal,
  type ControlPlaneStore,
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

/** Bound the work one sweep does, so a backlog cannot blow the cron budget. */
export const MAX_EXECUTIONS_PER_SWEEP = 20;
export const MAX_DISPATCHES_PER_SWEEP = 5;

export interface ReconcileDeps {
  store: ControlPlaneStore;
  provider: ExecutionProvider;
  schedules: readonly ScheduleDefinition[];
  mode: 'live' | 'shadow' | 'dry-run';
  /** Where a runner reports claim/result (the Worker's own public URL). */
  callbackUrl: string;
  lookbackHours?: number;
  runId?: string;
}

/**
 * A full sweep: create what is missing, expire what is no longer wanted, adopt the
 * provider's verdict for anything already running, then start the attempts that
 * are genuinely due.
 *
 * Order matters — provider reconciliation happens BEFORE dispatch so a slot whose
 * runner already finished (or died) is not handed to a second runner first.
 */
export async function reconcileAll(
  deps: ReconcileDeps,
  nowMs: number
): Promise<ReconciliationSummary> {
  const { store, provider, schedules } = deps;
  const summary = await reconcile(store, schedules, nowMs, {
    ...(deps.lookbackHours !== undefined ? { lookbackHours: deps.lookbackHours } : {}),
    ...(deps.runId !== undefined ? { runId: deps.runId } : {}),
  });

  const maxAttemptsFor = (scheduleId: string): number =>
    schedules.find((schedule) => schedule.id === scheduleId)?.maxAttempts ?? 1;
  const scheduleById = new Map(schedules.map((schedule) => [schedule.id, schedule]));

  // 1. Adopt provider state for executions already in flight (callback-loss and
  //    dead-runner recovery both funnel through here).
  const open = await store.listOpenExecutions(MAX_EXECUTIONS_PER_SWEEP);
  for (const execution of open) {
    try {
      const outcome = await reconcileExecution(
        store,
        execution,
        provider,
        maxAttemptsFor(scheduleIdOf(execution.slotId, scheduleById)),
        nowMs
      );
      if (outcome !== 'unchanged') summary.reconciled += 1;
    } catch (error) {
      summary.errors.push(
        `reconcile ${execution.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // 2. Dispatch what is due. `slot_occurrences.attempt_count` was incremented by
  //    the previous dispatch, so the next attempt number is count + 1.
  const windowStart = nowMs - (deps.lookbackHours ?? RECONCILIATION_LOOKBACK_HOURS) * 60 * 60 * 1000;
  const active = await store.listActiveOccurrences(windowStart, nowMs);
  const due = dueForDispatch(active, nowMs, maxAttemptsFor).slice(0, MAX_DISPATCHES_PER_SWEEP);

  if (provider.ready === false) {
    // Not configured yet: record the situation and leave the occurrences pending
    // instead of opening attempts that cannot start (and would consume retries).
    if (due.length > 0) {
      summary.errors.push('execution provider not ready; dispatch skipped');
      await store.logEvents(
        due.map((slot) => ({
          ts: nowMs,
          event: 'dispatch_skipped',
          slotId: slot.id,
          scheduleId: slot.scheduleId,
          botId: slot.botId,
          detail: 'execution provider not ready',
        }))
      );
    }
    await store.recordReconciliation({
      id: deps.runId ?? `reconcile-${nowMs}`,
      startedAt: nowMs,
      finishedAt: nowMs,
      summary,
    });
    return summary;
  }

  for (const slot of due) {
    const schedule = scheduleById.get(slot.scheduleId);
    if (!schedule) continue;
    try {
      const result = await startAttempt(
        store,
        provider,
        {
          slot,
          scheduleId: slot.scheduleId,
          botId: slot.botId,
          attempt: slot.attemptCount + 1,
          targets: schedule.targets.map((target) => target.id),
          callbackUrl: deps.callbackUrl,
          mode: deps.mode,
        },
        nowMs
      );
      if (result.dispatched) {
        summary.dispatched += 1;
      } else {
        summary.retried += 1;
      }
    } catch (error) {
      summary.errors.push(
        `dispatch ${slot.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  await store.recordReconciliation({
    id: deps.runId ?? `reconcile-${nowMs}`,
    startedAt: nowMs,
    finishedAt: nowMs,
    summary,
  });

  return summary;
}

/** Slot ids are `<scheduleId>@<local>`, so the schedule id is recoverable. */
function scheduleIdOf(
  slotId: string,
  scheduleById: Map<string, ScheduleDefinition>
): string {
  const at = slotId.indexOf('@');
  const scheduleId = at > 0 ? slotId.slice(0, at) : slotId;
  return scheduleById.has(scheduleId) ? scheduleId : '';
}
