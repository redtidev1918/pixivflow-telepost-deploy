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
