/**
 * Storage port for the control plane.
 *
 * Reconciliation is written against this narrow interface rather than against D1
 * directly, for two reasons that both matter operationally:
 *  - the state machine can be tested exhaustively (including failure injection)
 *    without emulating Cloudflare;
 *  - D1 stays a replaceable detail, so a future execution/control host change
 *    does not rewrite the reconciliation logic.
 */

import type { Occurrence } from './occurrences';

export type SlotStatus =
  | 'pending'
  | 'dispatched'
  | 'running'
  | 'success'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'uncertain';

export const TERMINAL_SLOT_STATUSES: readonly SlotStatus[] = [
  'success',
  'partial',
  'failed',
  'cancelled',
  'expired',
];

export function isTerminal(status: SlotStatus): boolean {
  return TERMINAL_SLOT_STATUSES.includes(status);
}

export interface OccurrenceRow {
  id: string;
  scheduleId: string;
  botId: string;
  occurrenceAt: number;
  status: SlotStatus;
  attemptCount: number;
  dispatchDeadline: number | null;
  currentExecutionId: string | null;
  dispatchedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  lastError: string | null;
}

export interface ReconciliationSummary {
  /** Occurrences that the ledger did not have yet. */
  created: number;
  /** Occurrences handed to the execution provider this sweep. */
  dispatched: number;
  /** Execution states refreshed from the provider (callback loss recovery). */
  reconciled: number;
  /** New attempts created for a non-terminal, retryable occurrence. */
  retried: number;
  /** Occurrences that will never be dispatched (past their business deadline). */
  expired: number;
  errors: string[];
}

export interface EventRecord {
  ts: number;
  event: string;
  slotId?: string;
  scheduleId?: string;
  executionId?: string;
  attempt?: number;
  providerRunId?: string;
  targetId?: string;
  botId?: string;
  detail?: string;
}

export interface ControlStore {
  /** Idempotent by construction: the caller may run it on every sweep. */
  insertOccurrenceIfAbsent(occurrence: Occurrence, nowMs: number): Promise<'created' | 'exists'>;
  /** Non-terminal occurrences inside the reconciliation window. */
  listActiveOccurrences(fromMs: number, toMs: number): Promise<OccurrenceRow[]>;
  /** Most recent occurrences, for /api/status. */
  listRecentOccurrences(limit: number): Promise<OccurrenceRow[]>;
  countByStatus(): Promise<Record<string, number>>;
  markExpired(slotId: string, reason: string, nowMs: number): Promise<void>;
  recordReconciliation(input: {
    id: string;
    startedAt: number;
    finishedAt: number;
    summary: ReconciliationSummary;
  }): Promise<void>;
  logEvents(events: EventRecord[]): Promise<void>;
}

export type ExecutionStatus =
  | 'dispatching'
  | 'dispatched'
  | 'running'
  | 'success'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'uncertain';

export const TERMINAL_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'success',
  'partial',
  'failed',
  'cancelled',
  'timeout',
  'uncertain',
];

export function isTerminalExecution(status: ExecutionStatus): boolean {
  return TERMINAL_EXECUTION_STATUSES.includes(status);
}

export interface ExecutionRow {
  id: string;
  slotId: string;
  attempt: number;
  provider: string;
  providerRunId: string | null;
  status: ExecutionStatus;
  createdAt: number;
  dispatchedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  errorClass: string | null;
  result: string | null;
}

/**
 * Execution/attempt storage. Kept separate from the occurrence methods because it
 * is the runner-facing half of the ledger: "which disposable runner tried this"
 * versus "what the business needs".
 */
export interface ExecutionStore {
  /** Idempotent: (slot_id, attempt) is unique, so a racing sweep cannot double-open. */
  openExecution(input: {
    id: string;
    slotId: string;
    attempt: number;
    provider: string;
    nowMs: number;
  }): Promise<'created' | 'exists'>;
  getExecution(executionId: string): Promise<ExecutionRow | null>;
  /** Newest execution for a slot (used to decide retry eligibility). */
  latestExecutionForSlot(slotId: string): Promise<ExecutionRow | null>;
  /** Non-terminal executions, to be refreshed from the provider. */
  listOpenExecutions(limit: number): Promise<ExecutionRow[]>;
  /** Dispatched but never claimed by a runner (lost dispatch response). */
  listUnclaimedExecutions(olderThanMs: number, limit: number): Promise<ExecutionRow[]>;
  attachProviderRun(executionId: string, providerRunId: string, nowMs: number): Promise<void>;
  markExecutionRunning(executionId: string, providerRunId: string | null, nowMs: number): Promise<void>;
  /** Terminal transitions are write-once: a replayed callback returns the stored row. */
  markExecutionTerminal(input: {
    executionId: string;
    status: ExecutionStatus;
    nowMs: number;
    error?: string;
    errorClass?: string;
    result?: string;
  }): Promise<void>;
  setSlotStatus(
    slotId: string,
    status: SlotStatus,
    nowMs: number,
    options?: { error?: string; currentExecutionId?: string | null; startedAt?: number; completedAt?: number }
  ): Promise<void>;
  getOccurrence(slotId: string): Promise<OccurrenceRow | null>;
  /** Attempts already opened for a slot (dispatch ceiling). */
  countExecutionsForSlot(slotId: string): Promise<number>;
  /**
   * Record one target's outcome.
   *
   * Returns `skipped-terminal` when the stored item is already in a terminal
   * state: a target that succeeded is never overwritten because a later attempt
   * (or a sibling target) failed.
   */
  upsertSlotItem(input: {
    slotId: string;
    botId: string;
    item: SlotItemInput;
    nowMs: number;
  }): Promise<'created' | 'updated' | 'skipped-terminal'>;
  listSlotItems(slotId: string): Promise<SlotItemRow[]>;
}

export type ItemStatus =
  | 'pending'
  | 'selected'
  | 'downloaded'
  | 'delivery_pending'
  | 'submitted'
  | 'no_candidate'
  | 'duplicate'
  | 'failed'
  | 'uncertain';

export const TERMINAL_ITEM_STATUSES: readonly ItemStatus[] = [
  'submitted',
  'no_candidate',
  'duplicate',
  'failed',
  'uncertain',
];

export interface SlotItemInput {
  targetId: string;
  status: ItemStatus;
  workType?: string;
  workId?: string | null;
  error?: string;
  errorClass?: string;
}

export interface SlotItemRow {
  slotId: string;
  targetId: string;
  botId: string;
  workType: string;
  workId: string | null;
  status: ItemStatus;
  attemptCount: number;
  lastError: string | null;
  errorClass: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** Everything reconciliation and the callback routes need, in one port. */
export interface ControlPlaneStore extends ControlStore, ExecutionStore {}
