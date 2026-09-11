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
import {
  CREDENTIAL_ADMISSION,
  CREDENTIAL_HOLD_MAX_MS,
  RECONCILIATION_LOOKBACK_HOURS,
  type ScheduleDefinition,
} from './schedules';
import {
  isTerminal,
  type ControlPlaneStore,
  type ControlStore,
  type EventRecord,
  type OccurrenceRow,
  type ReconciliationSummary,
} from './store';

/**
 * A sweep id that is unique per invocation.
 *
 * `reconcile-${nowMs}` collides when two sweeps start in the same millisecond, and
 * `recordReconciliation` is an INSERT OR REPLACE — so the second sweep silently
 * replaced the first one's row, losing the record of a dispatch that really
 * happened. Overlapping sweeps are a feature here (that is what makes a lost cron
 * survivable), so every sweep must be recorded rather than deduplicated.
 */
function newRunId(nowMs: number): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `reconcile-${nowMs}-${suffix}`;
}

export interface ReconcileOptions {
  /** Overrides the configured lookback (used by tests and by ops tooling). */
  lookbackHours?: number;
  /** Correlation id for the sweep record; defaults to a per-invocation id. */
  runId?: string;
}

export function emptySummary(): ReconciliationSummary {
  return { created: 0, dispatched: 0, reconciled: 0, retried: 0, held: 0, expired: 0, errors: [] };
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
    // A backoff after a failure is a real constraint, not a suggestion: retrying
    // immediately is what spends a second runner on the same contended account
    // instead of waiting for it to clear.
    if (row.retryNotBefore !== null && row.retryNotBefore > nowMs) return false;
    // Automatic retry keeps its own ceiling; an operator recovery widens it by
    // exactly one per grant. Without the second term a recovered occurrence would
    // sit `pending` forever, because its attempts are already spent -- which is
    // what made a terminal occurrence unrecoverable before.
    return row.attemptCount < maxAttemptsFor(row.scheduleId) + row.recoveryCount;
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
  const runId = options.runId ?? newRunId(nowMs);
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
  /** Cutover control: create/expire/reconcile, but open no new attempts. */
  dispatchPaused?: boolean;
  /** Where a runner reports claim/result (the Worker's own public URL). */
  callbackUrl: string;
  /** PixivFlow ref the runners must execute (deployment configuration). */
  pixivflowRef: string;
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
  const events: EventRecord[] = [];
  for (const execution of open) {    try {
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

  // An occurrence that still has a live attempt must never be dispatched again.
  // Slot status alone is not enough under concurrency: a second sweep can read a
  // row before the first sweep's write is visible to it and open attempt N+1 next
  // to an in-flight attempt N. The open-execution set is read AFTER the provider
  // reconciliation above, so anything genuinely dead has already been resolved.
  const openExecutions = await store.listOpenExecutions(MAX_EXECUTIONS_PER_SWEEP);
  const busy = new Set(openExecutions.map((execution) => execution.slotId));

  // Which shared credential is already taken, and by how many holders. A holder is
  // any open execution whose schedule consumes that credential; it is released by
  // becoming terminal, and bounded so a lost runner cannot block the account
  // forever — the sweep before this one has already tried to resolve it.
  const busyByCredential = new Map<string, number>();
  for (const execution of openExecutions) {
    const scheduleId = scheduleIdOf(execution.slotId, scheduleById);
    const schedule = scheduleId ? scheduleById.get(scheduleId) : undefined;
    if (!schedule) continue;
    if (execution.startedAt !== null && nowMs - execution.startedAt > CREDENTIAL_HOLD_MAX_MS) {
      continue;
    }
    busyByCredential.set(
      schedule.credential,
      (busyByCredential.get(schedule.credential) ?? 0) + 1
    );
  }
  const due = dueForDispatch(active, nowMs, maxAttemptsFor)
    .filter((slot) => !busy.has(slot.id))
    .slice(0, MAX_DISPATCHES_PER_SWEEP);

  // Account-level admission. Every schedule here consumes the SAME Pixiv account,
  // and Pixiv rate-limits per account, so dispatching a second occurrence while
  // one holds the credential makes both slower and can push the account into
  // cooldown. The provider reconcile above already refreshed every open
  // execution, so a holder that is genuinely finished has been released by now.
  //
  // A held occurrence is NOT an error and NOT a retry: it simply stays pending and
  // a later sweep dispatches it. That is why this runs before any attempt is open.
  const held = admissionHolds(due, scheduleById, busyByCredential);

  if (deps.dispatchPaused === true) {
    // Deliberately NOT an error: a paused sweep is a normal operating state during a
    // cutover, and it is reported so "why did nothing dispatch" is answerable.
    if (due.length > 0) {
      summary.held += due.length;
      await store.logEvents(
        due.map((slot) => ({
          ts: nowMs,
          event: 'dispatch_paused',
          slotId: slot.id,
          scheduleId: slot.scheduleId,
          botId: slot.botId,
          detail: 'dispatch is paused for cutover',
        }))
      );
    }
    await store.recordReconciliation({
      id: deps.runId ?? newRunId(nowMs),
      startedAt: nowMs,
      finishedAt: nowMs,
      summary,
    });
    return summary;
  }

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
      id: deps.runId ?? newRunId(nowMs),
      startedAt: nowMs,
      finishedAt: nowMs,
      summary,
    });
    return summary;
  }

  for (const slot of due) {
    const schedule = scheduleById.get(slot.scheduleId);
    if (!schedule) continue;
    if (held.has(slot.id)) {
      // Visible on purpose: "why did 10:10 not run at 10:10" must be answerable
      // from state rather than by reading runner logs.
      events.push({
        ts: nowMs,
        event: 'dispatch_held',
        slotId: slot.id,
        scheduleId: slot.scheduleId,
        botId: slot.botId,
        detail: JSON.stringify({ reason: 'credential_busy', credential: schedule.credential }),
      });
      summary.held += 1;
      continue;
    }
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
          pixivflowRef: deps.pixivflowRef,
          credentialKey: schedule.credential,
        },
        nowMs
      );
      if (result.dispatched) {
        summary.dispatched += 1;
        // Reserve the credential for the rest of this sweep, or a second due
        // occurrence would pass the same admission check before either is live.
        busyByCredential.set(
          schedule.credential,
          (busyByCredential.get(schedule.credential) ?? 0) + 1
        );
        // A new attempt for an occurrence that already had one IS a retry; a
        // provider rejection is an error, not a retry (it must stay visible).
        if (slot.attemptCount > 0) summary.retried += 1;
      } else if (result.detail === 'attempt already open') {
        // Two sweeps (or two concurrent ticks) both saw this occurrence as due and
        // the unique (slot_id, attempt) key elected one dispatcher. Converging is
        // the correct outcome — not an error worth alerting on.
        events.push({
          ts: nowMs,
          event: 'dispatch_converged',
          slotId: slot.id,
          scheduleId: slot.scheduleId,
          executionId: result.executionId,
          attempt: slot.attemptCount + 1,
          botId: slot.botId,
        });
      } else if (result.detail === 'credential busy') {
        // The atomic acquire lost the race: another reconciler opened the holder
        // between this sweep's admission read and its write. Same outcome as the
        // pre-check would have produced, so it is `held` -- an error here would make
        // a correct, converging system look broken.
        events.push({
          ts: nowMs,
          event: 'dispatch_held',
          slotId: slot.id,
          scheduleId: slot.scheduleId,
          botId: slot.botId,
          detail: JSON.stringify({ reason: 'credential_busy', credential: schedule.credential }),
        });
        summary.held += 1;
      } else if (result.detail) {
        summary.errors.push(`dispatch ${slot.id}: ${result.detail}`);
      }
    } catch (error) {
      summary.errors.push(
        `dispatch ${slot.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  if (events.length > 0) await store.logEvents(events);

  await store.recordReconciliation({
    id: deps.runId ?? newRunId(nowMs),
    startedAt: nowMs,
    finishedAt: nowMs,
    summary,
  });

  return summary;
}

/**
 * Which of the due occurrences must wait for a shared credential.
 *
 * Admission is per credential, not per slot: two different schedules sharing one
 * Pixiv account cannot run together, which is exactly the case a per-slot
 * concurrency group cannot express.
 */
function admissionHolds(
  due: readonly OccurrenceRow[],
  scheduleById: Map<string, ScheduleDefinition>,
  busyByCredential: Map<string, number>
): Set<string> {
  const remaining = new Map(busyByCredential);
  const held = new Set<string>();
  for (const slot of due) {
    const schedule = scheduleById.get(slot.scheduleId);
    if (!schedule) continue;
    const limit = CREDENTIAL_ADMISSION[schedule.credential] ?? 1;
    const inUse = remaining.get(schedule.credential) ?? 0;
    if (inUse >= limit) {
      held.add(slot.id);
      continue;
    }
    remaining.set(schedule.credential, inUse + 1);
  }
  return held;
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
