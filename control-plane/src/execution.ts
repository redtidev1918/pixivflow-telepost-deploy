/**
 * Execution state machine.
 *
 * One business occurrence (`slot_occurrences`) may be fulfilled by several
 * disposable executions (`executions`), each of which is a single runner attempt.
 * Keeping those apart is what lets a failed or timed-out runner be retried
 * without rewriting the business record, and lets a replayed callback be a no-op
 * instead of a second rollup.
 *
 * Two rules drive every function here:
 *  - dispatch is at-most-once by policy: a lost HTTP response is recovered from
 *    provider state, never retried blindly;
 *  - only the provider decides whether a runner is alive. No heartbeat, no timer,
 *    no local process state is ever treated as evidence.
 */

import type { ExecutionProvider, ProviderConclusion, ProviderRun } from './provider';
import {
  isTerminalExecution,
  type ControlPlaneStore,
  type EventRecord,
  type ExecutionRow,
  type ExecutionStatus,
  type OccurrenceRow,
  type SlotStatus,
} from './store';

/**
 * How long a dispatched attempt may stay unclaimed by a runner before we assume
 * its dispatch never materialised.
 *
 * This is NOT a liveness lease: nothing is renewed, and a live runner is never
 * preempted by it — the runner's own claim arrives far sooner, and a runner that
 * claimed is judged by GitHub run state from then on.
 */
export const DISPATCH_CLAIM_GRACE_MS = 10 * 60 * 1000;

export function executionIdFor(slotId: string, attempt: number): string {
  return `${slotId}#${attempt}`;
}

export interface StartAttemptInput {
  slot: OccurrenceRow;
  scheduleId: string;
  botId: string;
  attempt: number;
  targets: string[];
  callbackUrl: string;
  mode: 'live' | 'shadow' | 'dry-run';
  /** Deployment-owned: which PixivFlow ref the runner executes. */
  pixivflowRef: string;
}

export interface StartAttemptResult {
  executionId: string;
  dispatched: boolean;
  detail?: string;
}

/**
 * Open attempt N for a slot and hand it to the provider.
 *
 * `openExecution` is unique on (slot_id, attempt), so two concurrent sweeps or a
 * replayed clock cannot open two runners for the same attempt.
 */
export async function startAttempt(
  store: ControlPlaneStore,
  provider: ExecutionProvider,
  input: StartAttemptInput,
  nowMs: number
): Promise<StartAttemptResult> {
  const executionId = executionIdFor(input.slot.id, input.attempt);

  const opened = await store.openExecution({
    id: executionId,
    slotId: input.slot.id,
    attempt: input.attempt,
    provider: provider.name,
    nowMs,
  });
  if (opened === 'exists') {
    return { executionId, dispatched: false, detail: 'attempt already open' };
  }

  // The slot is marked dispatched BEFORE the provider call: if the process dies
  // mid-dispatch, reconciliation sees an unclaimed attempt and resolves it from
  // provider state instead of silently losing the occurrence.
  await store.setSlotStatus(input.slot.id, 'dispatched', nowMs, { currentExecutionId: executionId });
  await store.logEvents([
    {
      ts: nowMs,
      event: 'dispatch_started',
      slotId: input.slot.id,
      scheduleId: input.scheduleId,
      executionId,
      attempt: input.attempt,
      botId: input.botId,
      detail: JSON.stringify({ mode: input.mode, targets: input.targets }),
    },
  ]);

  let dispatchResult;
  try {
    dispatchResult = await provider.dispatch({
      slotId: input.slot.id,
      scheduleId: input.scheduleId,
      botId: input.botId,
      occurrenceAt: input.slot.occurrenceAt,
      attempt: input.attempt,
      targets: input.targets,
      callbackUrl: input.callbackUrl,
      mode: input.mode,
      pixivflowRef: input.pixivflowRef,
    });
  } catch (error) {
    // A thrown dispatch (network failure, provider bug, bad credentials) must be
    // recorded as a failed attempt right away: leaving it in `dispatching` would
    // silently consume one of the occurrence's attempts until the unclaimed-run
    // grace expires.
    dispatchResult = {
      accepted: false,
      detail: `dispatch threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!dispatchResult.accepted) {
    // A refused dispatch did not start a runner, so the attempt is over and the
    // slot returns to the dispatchable state while attempts remain.
    await store.markExecutionTerminal({
      executionId,
      status: 'failed',
      nowMs,
      error: dispatchResult.detail ?? 'dispatch rejected',
      errorClass: 'provider_error',
    });
    await store.setSlotStatus(input.slot.id, 'pending', nowMs, {
      error: dispatchResult.detail ?? 'dispatch rejected',
      currentExecutionId: null,
    });
    await store.logEvents([
      {
        ts: nowMs,
        event: 'dispatch_failed',
        slotId: input.slot.id,
        scheduleId: input.scheduleId,
        executionId,
        attempt: input.attempt,
        botId: input.botId,
        detail: dispatchResult.detail ?? 'dispatch rejected',
      },
    ]);
    return { executionId, dispatched: false, detail: dispatchResult.detail };
  }

  await store.logEvents([
    {
      ts: nowMs,
      event: 'dispatch_success',
      slotId: input.slot.id,
      scheduleId: input.scheduleId,
      executionId,
      attempt: input.attempt,
      botId: input.botId,
    },
  ]);
  return { executionId, dispatched: true };
}

/** Runner side: "I am alive and this is my provider run id." Idempotent. */
export async function claimExecution(
  store: ControlPlaneStore,
  input: { executionId: string; providerRunId: string | null },
  nowMs: number
): Promise<{ ok: boolean; execution: ExecutionRow | null }> {
  const execution = await store.getExecution(input.executionId);
  if (!execution) return { ok: false, execution: null };
  if (isTerminalExecution(execution.status)) {
    // A late claim for an already-finished execution changes nothing.
    return { ok: true, execution };
  }
  await store.markExecutionRunning(input.executionId, input.providerRunId, nowMs);
  await store.setSlotStatus(execution.slotId, 'running', nowMs, {
    currentExecutionId: input.executionId,
    startedAt: nowMs,
  });
  await store.logEvents([
    {
      ts: nowMs,
      event: 'github_run_started',
      slotId: execution.slotId,
      executionId: input.executionId,
      attempt: execution.attempt,
      providerRunId: input.providerRunId ?? undefined,
    },
  ]);
  return { ok: true, execution: await store.getExecution(input.executionId) };
}

export interface ApplyResultInput {
  executionId: string;
  status: ExecutionStatus;
  maxAttempts: number;
  result?: string;
  error?: string;
  errorClass?: string;
}

export interface ApplyResultOutcome {
  /** false when the execution was already terminal (replayed callback). */
  applied: boolean;
  execution: ExecutionRow;
  slotStatus: SlotStatus | null;
}

/**
 * Record a terminal execution state and roll the slot up.
 *
 * Idempotent by construction: a duplicate callback, a GitHub-rerun report and a
 * reconciliation sweep all funnel through here, and only the first one rolls up.
 */
export async function applyExecutionResult(
  store: ControlPlaneStore,
  input: ApplyResultInput,
  nowMs: number
): Promise<ApplyResultOutcome | null> {
  const execution = await store.getExecution(input.executionId);
  if (!execution) return null;
  if (isTerminalExecution(execution.status)) {
    return { applied: false, execution, slotStatus: (await store.getOccurrence(execution.slotId))?.status ?? null };
  }

  await store.markExecutionTerminal({
    executionId: input.executionId,
    status: input.status,
    nowMs,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.errorClass !== undefined ? { errorClass: input.errorClass } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
  });

  const slotStatus = slotRollup(input.status, execution.attempt, input.maxAttempts);
  const terminal = slotStatus !== 'pending';
  await store.setSlotStatus(execution.slotId, slotStatus, nowMs, {
    ...(input.error !== undefined ? { error: input.error } : {}),
    currentExecutionId: null,
    ...(terminal ? { completedAt: nowMs } : {}),
  });

  const events: EventRecord[] = [
    {
      ts: nowMs,
      event: 'github_run_finished',
      slotId: execution.slotId,
      executionId: input.executionId,
      attempt: execution.attempt,
      providerRunId: execution.providerRunId ?? undefined,
      detail: JSON.stringify({ status: input.status, errorClass: input.errorClass ?? null }),
    },
  ];
  if (terminal) {
    events.push({
      ts: nowMs,
      event: 'slot_terminal',
      slotId: execution.slotId,
      executionId: input.executionId,
      attempt: execution.attempt,
      detail: JSON.stringify({ status: slotStatus, errorClass: input.errorClass ?? null }),
    });
  } else {
    events.push({
      ts: nowMs,
      event: 'retry_scheduled',
      slotId: execution.slotId,
      executionId: input.executionId,
      attempt: execution.attempt,
      detail: JSON.stringify({ nextAttempt: execution.attempt + 1 }),
    });
  }
  await store.logEvents(events);

  return {
    applied: true,
    execution: (await store.getExecution(input.executionId)) ?? execution,
    slotStatus,
  };
}

/**
 * How a finished execution maps onto the business occurrence.
 *
 * A failed attempt is not a failed occurrence while attempts remain: it goes back
 * to `pending` so the next sweep dispatches attempt N+1 for the SAME slot.
 * `uncertain` is deliberately terminal — an unconfirmed Telegram send must never
 * be retried automatically.
 */
export function slotRollup(
  status: ExecutionStatus,
  attempt: number,
  maxAttempts: number
): SlotStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'partial':
      return 'partial';
    case 'uncertain':
      return 'uncertain';
    default:
      return attempt < maxAttempts ? 'pending' : 'failed';
  }
}

export function statusFromConclusion(conclusion: ProviderConclusion): {
  status: ExecutionStatus;
  errorClass: string;
} {
  switch (conclusion) {
    case 'success':
      return { status: 'success', errorClass: 'none' };
    case 'cancelled':
      // Measured against real GitHub: a JOB-level timeout (`timeout-minutes`) is
      // reported as `cancelled`, not `timed_out`, and the killed job never runs its
      // reporting steps — this conclusion is the only signal we get. It maps to a
      // retryable state, which is what keeps a timed-out runner from stranding the
      // occurrence.
      return { status: 'cancelled', errorClass: 'cancelled' };
    case 'timed_out':
      // Providers (or a future execution plane) that do report a timeout explicitly.
      return { status: 'timeout', errorClass: 'timeout' };
    case 'failure':
      return { status: 'failed', errorClass: 'infrastructure_error' };
    case 'startup_failure':
      return { status: 'failed', errorClass: 'provider_error' };
    case 'action_required':
      // A run that never started because a human must approve it is a provider
      // problem, not a retryable content problem.
      return { status: 'failed', errorClass: 'provider_error' };
    default:
      return { status: 'failed', errorClass: 'provider_error' };
  }
}

/**
 * Refresh one non-terminal execution from the provider.
 *
 * This is the callback-loss recovery path: even if the runner's final POST never
 * arrives, the next sweep asks GitHub what happened and closes the execution with
 * the provider's verdict.
 */
export async function reconcileExecution(
  store: ControlPlaneStore,
  execution: ExecutionRow,
  provider: ExecutionProvider,
  maxAttempts: number,
  nowMs: number
): Promise<'unchanged' | 'reconciled' | 'abandoned'> {
  if (execution.providerRunId) {
    const run = await provider.getRun(execution.providerRunId);
    return applyProviderRun(store, execution, run, maxAttempts, nowMs);
  }

  // No run id: either the runner has not claimed yet, or the dispatch response
  // was lost. Within the grace window this is simply "too early".
  if (nowMs - execution.createdAt <= DISPATCH_CLAIM_GRACE_MS) return 'unchanged';

  const recent = await provider.listRecentRuns(execution.createdAt - 60_000);
  const candidate = recent.find(
    (run) => run.createdAt !== undefined && run.createdAt >= execution.createdAt
  );
  if (candidate) {
    // Adopt the run the provider really started: the dispatch response was lost,
    // the work was not.
    await store.attachProviderRun(execution.id, candidate.runId, nowMs);
    return 'reconciled';
  }

  await applyExecutionResult(
    store,
    {
      executionId: execution.id,
      status: 'failed',
      maxAttempts,
      error: 'dispatch never materialised: no provider run was created',
      errorClass: 'infrastructure_error',
    },
    nowMs
  );
  return 'abandoned';
}

async function applyProviderRun(
  store: ControlPlaneStore,
  execution: ExecutionRow,
  run: ProviderRun,
  maxAttempts: number,
  nowMs: number
): Promise<'unchanged' | 'reconciled'> {
  if (run.state === 'completed') {
    const { status, errorClass } = statusFromConclusion(run.conclusion);
    await applyExecutionResult(
      store,
      {
        executionId: execution.id,
        status,
        maxAttempts,
        error: `provider concluded ${run.conclusion ?? 'unknown'}`,
        errorClass,
      },
      nowMs
    );
    return 'reconciled';
  }
  if (execution.status !== 'running' && run.state === 'in_progress') {
    await store.markExecutionRunning(execution.id, run.runId, nowMs);
    return 'reconciled';
  }
  return 'unchanged';
}
