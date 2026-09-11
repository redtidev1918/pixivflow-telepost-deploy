/**
 * Operator recovery attempts.
 *
 * The problem this solves, stated exactly: an occurrence can exhaust its automatic
 * attempts because of a fault OUTSIDE the control plane, and then the ledger has no
 * safe way back. That is not hypothetical. `bot1-daily@2026-09-11T1000` reached
 * `failed` with 3/3 attempts spent because the legacy Fly watchdog woke the old
 * execution plane, both planes shared one Pixiv credential, and every attempt died
 * in rate-limit cooldown -- while the occurrence itself was perfectly fine.
 *
 * This is deliberately NOT a "reopen", and it never rewrites history:
 *
 *   - attempt 1/2/3 stay `failed` forever, with their errors, events and audits.
 *   - `attempt_count` is never reset. A grant returns the occurrence to `pending`
 *     with the count unchanged, so the next dispatch is attempt 4 -- a fourth
 *     attempt, not a disguised first one.
 *   - automatic retry keeps `maxAttempts`; each grant widens the dispatch ceiling
 *     by exactly one, so a grant buys one attempt and no more.
 *   - the canonical occurrence identity is untouched: same `slot_id`, same
 *     `occurrence_at`. No synthetic occurrence is created.
 *   - nothing is dispatched here. The occurrence becomes schedulable and normal
 *     reconciliation plus credential admission decide when it runs, so the
 *     `pixiv-main` single-execution admission and the retry/backoff gate still
 *     apply.
 *
 * Recovery is an operator act, so it requires a stated reason and is recorded as
 * `occurrence_requeued_by_operator`.
 */

import type {
  ControlPlaneStore,
  EventRecord,
  OccurrenceRow,
  ReviewRecord,
  SlotStatus,
} from './store';
import { isTerminal } from './store';

/**
 * Terminal statuses an operator may recover.
 *
 * `success` and `partial` are excluded on purpose: they already carry side effects,
 * and a whole-slot rerun would re-upload media for targets that already succeeded.
 * `uncertain` is excluded because its meaning is "we cannot prove what happened" --
 * the answer to that is a human deciding, not a second run. `expired` is excluded
 * because the business window closed; that is a content decision, not a recovery.
 */
export const RECOVERABLE_SLOT_STATUSES: readonly SlotStatus[] = ['failed', 'cancelled'];

/** Review states that prove a Telegram side effect already exists. */
const SIDE_EFFECT_REVIEW_STATUSES = ['published', 'publishing'] as const;

/**
 * Review states that are still open or retryable, so a second run for the same
 * occurrence would post a duplicate review card.
 */
const OPEN_REVIEW_STATUSES = ['pending', 'failed', 'publishing'] as const;

export type RecoveryRefusal =
  | 'slot_not_found'
  | 'reason_required'
  | 'status_not_recoverable'
  | 'active_execution'
  | 'published_side_effect'
  | 'unresolved_uncertain_review'
  | 'open_review_would_duplicate'
  | 'grant_conflict';

export interface RecoveryReport {
  slotId: string;
  dryRun: boolean;
  eligible: boolean;
  refusal: RecoveryRefusal | null;
  refusalDetail: string | null;
  /** `null` only when the slot does not exist. */
  currentStatus: SlotStatus | null;
  terminal: boolean;
  attemptsUsed: number;
  /** How many attempts automatic retry allowed. Unchanged by recovery. */
  maxAutomaticAttempts: number;
  /** Grants so far. The dispatch ceiling is maxAutomaticAttempts + this. */
  recoveryCount: number;
  recoveryGeneration: number;
  /** What the next dispatch will be numbered. Never renumbers earlier attempts. */
  nextAttempt: number;
  activeExecutions: number;
  uncertainReviews: number;
  publishedSideEffects: number;
  openReviews: number;
  /** Occurrence identity that a recovery must preserve. */
  scheduleId: string | null;
  botId: string | null;
  occurrenceAt: number | null;
  reason: string | null;
}

export interface RecoveryInput {
  slotId: string;
  reason: string;
  actor: string;
  nowMs: number;
  maxAutomaticAttempts: number;
  /** Fresh business window, in hours, measured from the operator action. */
  dispatchDeadlineHours: number;
  dryRun: boolean;
}

export interface RecoveryResult {
  report: RecoveryReport;
  /** `null` on a dry run or a refusal. */
  storeResult: 'requeued' | 'conflict' | 'not-found' | null;
  events: EventRecord[];
}

function baseReport(slotId: string, dryRun: boolean): RecoveryReport {
  return {
    slotId,
    dryRun,
    eligible: false,
    refusal: null,
    refusalDetail: null,
    currentStatus: null,
    terminal: false,
    attemptsUsed: 0,
    maxAutomaticAttempts: 0,
    recoveryCount: 0,
    recoveryGeneration: 0,
    nextAttempt: 0,
    activeExecutions: 0,
    uncertainReviews: 0,
    publishedSideEffects: 0,
    openReviews: 0,
    scheduleId: null,
    botId: null,
    occurrenceAt: null,
    reason: null,
  };
}

/** Slot header fields a report carries, independent of review state. */
function describeSlot(report: RecoveryReport, slot: OccurrenceRow, maxAutomaticAttempts: number): void {
  report.currentStatus = slot.status;
  report.terminal = isTerminal(slot.status);
  report.attemptsUsed = slot.attemptCount;
  report.recoveryCount = slot.recoveryCount;
  report.recoveryGeneration = slot.recoveryGeneration;
  report.maxAutomaticAttempts = maxAutomaticAttempts;
  // Never `attemptCount` reset + 1: the fourth attempt is the fourth attempt.
  report.nextAttempt = slot.attemptCount + 1;
  report.scheduleId = slot.scheduleId;
  report.botId = slot.botId;
  report.occurrenceAt = slot.occurrenceAt;
}

/** Review-derived figures, computed once so the report and the gate cannot disagree. */
function describeReviews(report: RecoveryReport, reviews: readonly ReviewRecord[]): void {
  report.uncertainReviews = reviews.filter((review) => review.status === 'uncertain').length;
  report.publishedSideEffects = reviews.filter(
    (review) =>
      (SIDE_EFFECT_REVIEW_STATUSES as readonly string[]).includes(review.status) ||
      review.publishedMessageId !== null
  ).length;
  report.openReviews = reviews.filter((review) =>
    (OPEN_REVIEW_STATUSES as readonly string[]).includes(review.status)
  ).length;
}

/**
 * Decide whether an occurrence may be recovered, and why not when it may not.
 *
 * Separate from the write path so the gate is testable without a store, and so the
 * dry run and the real requeue cannot diverge: both call this.
 */
export async function assessRecovery(
  store: ControlPlaneStore,
  input: RecoveryInput
): Promise<RecoveryReport> {
  const report = baseReport(input.slotId, input.dryRun);
  report.reason = input.reason.trim() || null;
  report.maxAutomaticAttempts = input.maxAutomaticAttempts;

  const slot = await store.getOccurrence(input.slotId);
  if (!slot) {
    report.refusal = 'slot_not_found';
    report.refusalDetail = 'no occurrence with that id';
    return report;
  }
  describeSlot(report, slot, input.maxAutomaticAttempts);

  // A reason is mandatory: the event log is the only record of why a terminal
  // occurrence ran again, and "someone clicked it" is not a reason.
  if (!report.reason) {
    report.refusal = 'reason_required';
    report.refusalDetail = 'operator recovery requires a stated reason';
    return report;
  }

  if (!(RECOVERABLE_SLOT_STATUSES as readonly string[]).includes(slot.status)) {
    report.refusal = 'status_not_recoverable';
    report.refusalDetail =
      slot.status === 'pending' || slot.status === 'dispatched' || slot.status === 'running'
        ? `occurrence is still in flight (${slot.status}); recovery is only for terminal occurrences`
        : `status '${slot.status}' is not recoverable by an operator`;
    return report;
  }

  report.activeExecutions = await store.countOpenExecutionsForSlot(input.slotId);
  if (report.activeExecutions > 0) {
    report.refusal = 'active_execution';
    report.refusalDetail = `${report.activeExecutions} execution(s) still hold this occurrence`;
    return report;
  }

  const reviews = await store.listReviewsForSlot(input.slotId);
  describeReviews(report, reviews);

  if (report.publishedSideEffects > 0) {
    report.refusal = 'published_side_effect';
    report.refusalDetail = 'a review for this occurrence was already published to a channel';
    return report;
  }
  if (report.uncertainReviews > 0) {
    report.refusal = 'unresolved_uncertain_review';
    report.refusalDetail =
      'an uncertain review exists; a human must decide it before this occurrence runs again';
    return report;
  }
  if (report.openReviews > 0) {
    report.refusal = 'open_review_would_duplicate';
    report.refusalDetail =
      'an undecided review for this occurrence already exists; rerunning would post a second card';
    return report;
  }

  report.eligible = true;
  return report;
}

/**
 * Grant the recovery attempt.
 *
 * The occurrence is returned to `pending`; dispatch is left to the normal sweep.
 * `grantRecoveryAttempt` is a single conditional UPDATE, so of two operators acting
 * on the same terminal generation exactly one wins and the other is told so.
 */
export async function recoverOccurrence(
  store: ControlPlaneStore,
  input: RecoveryInput
): Promise<RecoveryResult> {
  const report = await assessRecovery(store, input);
  if (!report.eligible) return { report, storeResult: null, events: [] };

  // Compare-and-set against what the GATE observed. Re-reading here would be a bug:
  // a concurrent grant moves the row, and a fresh read would carry the moved state
  // into the expected values, so the second request would happily widen the ceiling
  // again instead of losing the race.
  const storeResult = await store.grantRecoveryAttempt({
    slotId: input.slotId,
    reason: report.reason ?? '',
    actor: input.actor,
    nowMs: input.nowMs,
    // A recovery gets a FRESH business window measured from now, not the window
    // that expired while the occurrence was failing.
    dispatchDeadline: input.nowMs + input.dispatchDeadlineHours * 60 * 60 * 1000,
    expectedStatus: report.currentStatus as SlotStatus,
    expectedGeneration: report.recoveryGeneration,
  });

  if (storeResult !== 'requeued') {
    report.eligible = false;
    report.refusal = 'grant_conflict';
    report.refusalDetail =
      'another recovery or a state change won the race; re-read the occurrence before retrying';
    return { report, storeResult, events: [] };
  }

  const detail = JSON.stringify({
    previousStatus: report.currentStatus,
    previousAttemptCount: report.attemptsUsed,
    nextAttempt: report.nextAttempt,
    recoveryCount: report.recoveryCount + 1,
    recoveryGeneration: report.recoveryGeneration + 1,
    automaticMaxAttempts: input.maxAutomaticAttempts,
    reason: report.reason,
    actor: input.actor,
    activeExecutions: report.activeExecutions,
    uncertainReviews: report.uncertainReviews,
    publishedSideEffects: report.publishedSideEffects,
    openReviews: report.openReviews,
  });

  return {
    report,
    storeResult,
    events: [
      {
        ts: input.nowMs,
        event: 'occurrence_requeued_by_operator',
        slotId: input.slotId,
        ...(report.scheduleId !== null ? { scheduleId: report.scheduleId } : {}),
        ...(report.botId !== null ? { botId: report.botId } : {}),
        attempt: report.nextAttempt,
        detail,
      },
    ],
  };
}

/**
 * Audit a refusal.
 *
 * A refused recovery is as worth recording as a granted one: "why can I not retry
 * this" is a question the event log should answer. Dry runs are not recorded -- they
 * write nothing at all, which is the point of a dry run.
 */
export function refusalEvent(report: RecoveryReport, nowMs: number): EventRecord | null {
  if (report.dryRun || report.eligible || !report.refusal) return null;
  return {
    ts: nowMs,
    event: 'occurrence_requeue_refused',
    slotId: report.slotId,
    ...(report.scheduleId !== null ? { scheduleId: report.scheduleId } : {}),
    detail: JSON.stringify({
      refusal: report.refusal,
      refusalDetail: report.refusalDetail,
      status: report.currentStatus,
      attemptsUsed: report.attemptsUsed,
      activeExecutions: report.activeExecutions,
      uncertainReviews: report.uncertainReviews,
      publishedSideEffects: report.publishedSideEffects,
      openReviews: report.openReviews,
      reason: report.reason,
    }),
  };
}
