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

export interface ReconciliationRunRow {
  id: string;
  startedAt: number;
  finishedAt: number;
  summary: ReconciliationSummary;
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

/**
 * Read side of the sweep ledger.
 *
 * The architecture rests on the cron being the only clock, so "did the clock
 * run?" has to be answerable from state: without it a lost cron looks exactly
 * like a quiet day until an occurrence is missing hours later. Kept out of
 * ControlStore so a test that only exercises the state machine need not fake it.
 */
export interface ObservabilityStore {
  listRecentReconciliations(limit: number): Promise<ReconciliationRunRow[]>;
}

/** Everything reconciliation and the callback routes need, in one port. */
export interface ControlPlaneStore
  extends ControlStore,
    ExecutionStore,
    ReviewStore,
    ProcessedWorkStore,
    ObservabilityStore {}

/**
 * Review states, ported from TelePost's production state machine
 * (telepost/domain/review.py) so the proven semantics survive the move.
 *
 *   pending -> publishing -> published
 *                   |  \-> failed (re-claimable; the approve button becomes
 *                   |            "retry publish", which is why a failed publish
 *                   |            must stay distinguishable from an undecided one)
 *                   \-> uncertain (this deployment's addition: an ambiguous
 *                       publish is a human's problem, never an automatic retry)
 *
 * `preparing` is deliberately absent: TelePost needs it because it persists a row
 * before uploading the preview. Here the runner uploads first and reports after,
 * so there is no pre-message row to model.
 */
export type ReviewStatus =
  | 'pending'
  | 'publishing'
  | 'published'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'uncertain';

/** Nothing more happens without a human. Never move back to `publishing`. */
export const TERMINAL_REVIEW_STATUSES: readonly ReviewStatus[] = [
  'published',
  'rejected',
  'expired',
  'uncertain',
];

/** A publish may be claimed from these (TelePost's CLAIMABLE set). */
export const CLAIMABLE_REVIEW_STATUSES: readonly ReviewStatus[] = ['pending', 'failed'];

/**
 * A later occurrence may re-open these.
 *
 * Both are terminal without having published anything, so the work is still
 * unpublished and a fresh decision is legitimate — TelePost scopes its work-level
 * dedupe to published rows for the same reason. Everything else blocks: `pending`
 * and `failed` already have a live decision, `publishing` may be mid-send, and
 * `published`/`uncertain` may already be in the channel.
 *
 * Without this, a re-selected work uploads fresh media that no button can act on:
 * the create returns the old terminal row, and the press is refused as expired.
 */
export const RESETTABLE_REVIEW_STATUSES: readonly ReviewStatus[] = ['expired', 'rejected'];

/**
 * A stale claim is recomputed from these, never re-published blindly.
 *
 * TelePost reclaims a stale `publishing` row after 300s and re-runs the publish.
 * That is safe only when its delivery ledger already proves the send happened; a
 * crash after Telegram accepted the copy and before the ledger row was written
 * leaves no such evidence, and the reclaim then posts the media a second time.
 * Here the recorded message id IS that evidence: present, the claim is resolved
 * as published; absent, the outcome is genuinely unknown and becomes `uncertain`.
 */
export const PUBLISHING_STALE_MS = 5 * 60 * 1000;

export interface ReviewRecord {
  id: string;
  botId: string;
  slotId: string | null;
  targetId: string | null;
  workId: string | null;
  /** Chat the review message lives in (media stays in Telegram, never here). */
  chatId: string;
  messageId: number | null;
  /** A review can be an album: every message id of the media group. */
  messageIds: number[] | null;
  mediaGroupId: string | null;
  fileIds: string[] | null;
  caption: string | null;
  /** Channel the accepted review is copied to (server-side, by Telegram). */
  publishChatId: string | null;
  publishThreadId: number | null;
  status: ReviewStatus;
  createdAt: number;
  updatedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  publishedMessageId: number | null;
  lastError: string | null;
}

export interface ReviewStore {
  /** Counts by status: an `uncertain` review exists to be seen by a human. */
  countReviewsByStatus(): Promise<Record<string, number>>;
  /**
   * Atomically claim a review for publishing.
   *
   * ONE conditional UPDATE, ported from TelePost
   * (telepost/storage/sqlite/reviews.py:191-221): it moves `pending`/`failed` to
   * `publishing` and is also the stale-reclaim path, so two concurrent approvers
   * can never both proceed. Returns the row as it is now, claimed or not, so the
   * caller can tell "someone else is publishing" from "already published".
   */
  claimReviewForPublishing(input: {
    reviewId: string;
    nowMs: number;
    staleMs: number;
  }): Promise<{ claimed: boolean; record: ReviewRecord | null }>;
  /**
   * Record the message Telegram actually created, while still `publishing`.
   *
   * Written BEFORE the terminal transition on purpose. A crash in between leaves
   * a `publishing` row that already proves the copy landed, which is what lets
   * the reaper resolve it as published instead of asking a human or resending.
   */
  recordPublishedMessage(input: {
    reviewId: string;
    publishedMessageId: number | null;
    nowMs: number;
  }): Promise<boolean>;
  /** Claims left `publishing` for too long: crash evidence, not a queue. */
  listStalePublishing(input: { olderThanMs: number; limit: number }): Promise<ReviewRecord[]>;
  /** Idempotent on (bot_id, target_id, work_id): a replayed create returns the row. */
  createReview(input: {
    id: string;
    botId: string;
    slotId?: string | null;
    targetId?: string | null;
    workId?: string | null;
    chatId: string;
    messageId?: number | null;
    messageIds?: number[] | null;
    mediaGroupId?: string | null;
    fileIds?: string[] | null;
    caption?: string | null;
    publishChatId?: string | null;
    publishThreadId?: number | null;
    /** `uncertain` records a send whose outcome could not be confirmed. */
    status?: 'pending' | 'uncertain';
    error?: string | null;
    nowMs: number;
  }): Promise<{ record: ReviewRecord; created: boolean }>;
  getReview(reviewId: string): Promise<ReviewRecord | null>;
  listPendingReviews(limit: number): Promise<ReviewRecord[]>;
  /**
   * Compare-and-set on the review status. Returns false when another decision won
   * the race (or the review was already decided) — the caller must then NOT publish.
   */
  transitionReview(input: {
    reviewId: string;
    from: ReviewStatus;
    to: ReviewStatus;
    nowMs: number;
    actor?: string | null;
    error?: string | null;
  }): Promise<boolean>;
  /**
   * Terminal `publishing -> published`, guarded so a late writer cannot clobber a
   * row another actor already resolved. False means this caller no longer owns it.
   */
  markReviewPublished(input: {
    reviewId: string;
    publishedMessageId: number | null;
    nowMs: number;
    actor?: string | null;
  }): Promise<boolean>;
}

/**
 * Durable duplicate history.
 *
 * A disposable runner starts with an empty local database, so "has this work been
 * handled already?" cannot be answered from the runner. The control plane owns
 * that answer, and the runner asks for it before selecting candidates — otherwise
 * a fresh runner re-selects works that were delivered weeks ago and the day
 * silently produces nothing new.
 */
export interface ProcessedWorkStore {
  /** Idempotent on (bot_id, work_type, pixiv_id). Returns how many were new. */
  recordProcessedWorks(input: {
    botId: string;
    slotId?: string | null;
    works: Array<{ workType: string; pixivId: string; targetId?: string | null }>;
    nowMs: number;
  }): Promise<number>;
  /** Most recently recorded ids for a bot, newest first (bounded by `limit`). */
  listProcessedWorks(
    botId: string,
    limit: number
  ): Promise<Array<{ workType: string; pixivId: string }>>;
}
