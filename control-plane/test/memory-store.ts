/**
 * In-memory ControlPlaneStore used by the control-plane tests.
 *
 * It mirrors the semantics the D1 store guarantees (unique keys, write-once
 * terminal transitions, terminal items win) so the state machine and the failure
 * injection tests exercise real rules rather than a convenient fake.
 */

import type { Occurrence } from '../src/occurrences';
import { hashSecret } from '../src/secrets';
import type {
  DispatchRequest,
  DispatchResult,
  ExecutionProvider,
  ProviderConclusion,
  ProviderRun,
  ProviderRunState,
} from '../src/provider';
import {
  CLAIMABLE_REVIEW_STATUSES,
  RESETTABLE_REVIEW_STATUSES,
  isTerminalExecution,
  TERMINAL_ITEM_STATUSES,
  type ControlPlaneStore,
  type EventRecord,
  type ExecutionRow,
  type ExecutionStatus,
  type ItemStatus,
  type OccurrenceRow,
  type ReconciliationRunRow,
  type ReconciliationSummary,
  type ReviewRecord,
  type ReviewStatus,
  type RunnerCredentialRow,
  type RunnerCredentialSecret,
  type SlotItemInput,
  type SlotItemRow,
  type SlotStatus,
} from '../src/store';

/**
 * Rows are handed out as COPIES, exactly like D1 hands out snapshots.
 *
 * Returning the live objects made the store observe states real D1 cannot
 * produce: a caller could filter on one value and later read a mutated one, which
 * produced a second dispatch attempt for an occurrence that was already being
 * dispatched. Test-harness fidelity matters more than convenience here.
 */
function clone<T extends object>(row: T): T {
  return { ...row };
}

export class MemoryControlStore implements ControlPlaneStore {
  readonly slots = new Map<string, OccurrenceRow>();
  readonly executions = new Map<string, ExecutionRow>();
  readonly items = new Map<string, SlotItemRow>();
  readonly events: EventRecord[] = [];
  readonly runs: ReconciliationRunRow[] = [];

  private createdSlots = 0;
  private createdExecutions = 0;

  async insertOccurrenceIfAbsent(occurrence: Occurrence, nowMs: number): Promise<'created' | 'exists'> {
    if (this.slots.has(occurrence.slotId)) return 'exists';
    this.createdSlots += 1;
    this.slots.set(occurrence.slotId, {
      id: occurrence.slotId,
      scheduleId: occurrence.scheduleId,
      botId: occurrence.botId,
      occurrenceAt: occurrence.occurrenceAt,
      status: 'pending',
      attemptCount: 0,
      dispatchDeadline: occurrence.dispatchDeadline,
      currentExecutionId: null,
      dispatchedAt: null,
      retryNotBefore: null,
      startedAt: null,
      completedAt: null,
      lastError: null,
    });
    void nowMs;
    return 'created';
  }

  async listActiveOccurrences(fromMs: number, toMs: number): Promise<OccurrenceRow[]> {
    return [...this.slots.values()]
      .filter(
        (row) =>
          !['success', 'partial', 'failed', 'cancelled', 'expired'].includes(row.status) &&
          row.occurrenceAt >= fromMs &&
          row.occurrenceAt <= toMs
      )
      .sort((a, b) => a.occurrenceAt - b.occurrenceAt)
      .map(clone);
  }

  async listRecentOccurrences(limit: number): Promise<OccurrenceRow[]> {
    return [...this.slots.values()]
      .sort((a, b) => b.occurrenceAt - a.occurrenceAt)
      .slice(0, limit)
      .map(clone);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.slots.values()) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }

  async setRetryNotBefore(slotId: string, atMs: number): Promise<void> {
    const row = this.requireSlot(slotId);
    row.retryNotBefore = atMs;
  }

  async clearRetryNotBefore(slotId: string): Promise<void> {
    const row = this.requireSlot(slotId);
    row.retryNotBefore = null;
  }

  async markExpired(slotId: string, reason: string, nowMs: number): Promise<void> {
    const row = this.requireSlot(slotId);
    if (['success', 'partial', 'failed', 'cancelled', 'expired'].includes(row.status)) return;
    row.status = 'expired';
    row.completedAt = nowMs;
    row.lastError = reason;
  }

  async recordReconciliation(input: {
    id: string;
    startedAt: number;
    finishedAt: number;
    summary: ReconciliationSummary;
  }): Promise<void> {
    // D1 returns rows, so the fake must too: a fake that hands back live objects
    // has already hidden one real bug in this suite.
    this.runs.push({
      id: input.id,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      summary: { ...input.summary, errors: [...input.summary.errors] },
    });
  }

  async listRecentReconciliations(limit: number): Promise<ReconciliationRunRow[]> {
    return [...this.runs]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
      .map((run) => ({ ...run, summary: { ...run.summary, errors: [...run.summary.errors] } }));
  }

  async countReviewsByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const review of this.reviews.values()) {
      counts[review.status] = (counts[review.status] ?? 0) + 1;
    }
    return counts;
  }

  async logEvents(events: EventRecord[]): Promise<void> {
    this.events.push(...events);
  }

  async openExecution(input: {
    id: string;
    slotId: string;
    attempt: number;
    provider: string;
    nowMs: number;
  }): Promise<'created' | 'exists'> {
    const key = `${input.slotId}#${input.attempt}`;
    if (this.executions.has(key)) return 'exists';
    this.createdExecutions += 1;
    this.executions.set(key, {
      id: key,
      slotId: input.slotId,
      attempt: input.attempt,
      provider: input.provider,
      providerRunId: null,
      status: 'dispatching',
      createdAt: input.nowMs,
      dispatchedAt: null,
      startedAt: null,
      completedAt: null,
      error: null,
      errorClass: null,
      result: null,
    });
    return 'created';
  }

  async getExecution(executionId: string): Promise<ExecutionRow | null> {
    const row = this.executions.get(executionId);
    return row ? clone(row) : null;
  }

  async latestExecutionForSlot(slotId: string): Promise<ExecutionRow | null> {
    const rows = [...this.executions.values()].filter((row) => row.slotId === slotId);
    const latest = rows.sort((a, b) => b.attempt - a.attempt)[0];
    return latest ? clone(latest) : null;
  }

  async listOpenExecutions(limit: number): Promise<ExecutionRow[]> {
    return [...this.executions.values()]
      .filter((row) => !isTerminalExecution(row.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  async listUnclaimedExecutions(olderThanMs: number, limit: number): Promise<ExecutionRow[]> {
    return [...this.executions.values()]
      .filter((row) => row.status === 'dispatched' && row.providerRunId === null && row.createdAt <= olderThanMs)
      .slice(0, limit);
  }

  async attachProviderRun(executionId: string, providerRunId: string, nowMs: number): Promise<void> {
    const row = this.executions.get(executionId);
    if (!row || row.status !== 'dispatching') return;
    row.providerRunId = providerRunId;
    row.status = 'dispatched';
    row.dispatchedAt = nowMs;
  }

  async markExecutionRunning(executionId: string, providerRunId: string | null, nowMs: number): Promise<void> {
    const row = this.executions.get(executionId);
    if (!row || isTerminalExecution(row.status)) return;
    row.status = 'running';
    row.startedAt = row.startedAt ?? nowMs;
    row.providerRunId = providerRunId ?? row.providerRunId;
  }

  async markExecutionTerminal(input: {
    executionId: string;
    status: ExecutionStatus;
    nowMs: number;
    error?: string;
    errorClass?: string;
    result?: string;
  }): Promise<void> {
    const row = this.executions.get(input.executionId);
    if (!row || isTerminalExecution(row.status)) return;
    row.status = input.status;
    row.completedAt = input.nowMs;
    row.error = input.error ?? null;
    row.errorClass = input.errorClass ?? null;
    row.result = input.result ?? null;
  }

  async setSlotStatus(
    slotId: string,
    status: SlotStatus,
    nowMs: number,
    options: { error?: string; currentExecutionId?: string | null; startedAt?: number; completedAt?: number } = {}
  ): Promise<void> {
    const row = this.requireSlot(slotId);
    row.status = status;
    if (options.currentExecutionId !== undefined) row.currentExecutionId = options.currentExecutionId;
    if (options.error !== undefined) row.lastError = options.error;
    if (options.startedAt !== undefined) row.startedAt = row.startedAt ?? options.startedAt;
    if (options.completedAt !== undefined) row.completedAt = options.completedAt;
    if (status === 'dispatched') {
      row.attemptCount += 1;
      row.dispatchedAt = row.dispatchedAt ?? nowMs;
    }
  }

  async getOccurrence(slotId: string): Promise<OccurrenceRow | null> {
    const row = this.slots.get(slotId);
    return row ? clone(row) : null;
  }

  async countExecutionsForSlot(slotId: string): Promise<number> {
    return [...this.executions.values()].filter((row) => row.slotId === slotId).length;
  }

  async upsertSlotItem(input: {
    slotId: string;
    botId: string;
    item: SlotItemInput;
    nowMs: number;
  }): Promise<'created' | 'updated' | 'skipped-terminal'> {
    const key = `${input.slotId}::${input.item.targetId}`;
    const existing = this.items.get(key);
    // Mirrors D1: a terminal item is protected unless a STRICTLY later attempt
    // reports it, so a successful retry can correct the record.
    const terminal = existing !== undefined && TERMINAL_ITEM_STATUSES.includes(existing.status);
    if (terminal) {
      const supersedes =
        input.item.attempt !== undefined && input.item.attempt > existing!.attemptCount;
      if (!supersedes) return 'skipped-terminal';
    }

    if (!existing) {
      this.items.set(key, {
        slotId: input.slotId,
        targetId: input.item.targetId,
        botId: input.botId,
        workType: input.item.workType ?? 'unknown',
        workId: input.item.workId ?? null,
        status: input.item.status,
        attemptCount: input.item.attempt ?? 1,
        lastError: input.item.error ?? null,
        errorClass: input.item.errorClass ?? null,
        createdAt: input.nowMs,
        updatedAt: input.nowMs,
        completedAt: TERMINAL_ITEM_STATUSES.includes(input.item.status) ? input.nowMs : null,
      });
      return 'created';
    }

    existing.status = input.item.status;
    existing.workId = input.item.workId ?? existing.workId;
    existing.attemptCount = input.item.attempt ?? existing.attemptCount;
    existing.lastError = input.item.error ?? null;
    existing.errorClass = input.item.errorClass ?? null;
    existing.updatedAt = input.nowMs;
    if (TERMINAL_ITEM_STATUSES.includes(input.item.status)) existing.completedAt = input.nowMs;
    return 'updated';
  }

  async listSlotItems(slotId: string): Promise<SlotItemRow[]> {
    return [...this.items.values()].filter((row) => row.slotId === slotId).map(clone);
  }

  // ---- reviews --------------------------------------------------------------

  readonly reviews = new Map<string, ReviewRecord>();

  async createReview(input: {
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
    status?: 'pending' | 'uncertain';
    error?: string | null;
    nowMs: number;
  }): Promise<{ record: ReviewRecord; created: boolean }> {
    // Mirrors the D1 unique index on (bot_id, target_id, work_id).
    const existing = [...this.reviews.values()].find(
      (review) =>
        review.botId === input.botId &&
        review.targetId === (input.targetId ?? null) &&
        review.workId === (input.workId ?? null)
    );
    if (existing) {
      // Mirrors D1: only a review that ended without publishing may be re-opened.
      if (!RESETTABLE_REVIEW_STATUSES.includes(existing.status)) {
        return { record: { ...existing }, created: false };
      }
      existing.status = 'pending';
      existing.slotId = input.slotId ?? null;
      existing.messageId = input.messageId ?? null;
      existing.messageIds = input.messageIds ?? null;
      existing.mediaGroupId = input.mediaGroupId ?? null;
      existing.fileIds = input.fileIds ?? null;
      existing.caption = input.caption ?? null;
      existing.publishChatId = input.publishChatId ?? null;
      existing.publishThreadId = input.publishThreadId ?? null;
      existing.createdAt = input.nowMs;
      existing.updatedAt = input.nowMs;
      existing.decidedAt = null;
      existing.decidedBy = null;
      existing.publishedMessageId = null;
      existing.lastError = null;
      return { record: { ...existing }, created: false };
    }

    const record: ReviewRecord = {
      id: input.id,
      botId: input.botId,
      slotId: input.slotId ?? null,
      targetId: input.targetId ?? null,
      workId: input.workId ?? null,
      chatId: input.chatId,
      messageId: input.messageId ?? null,
      messageIds: input.messageIds ?? null,
      mediaGroupId: input.mediaGroupId ?? null,
      fileIds: input.fileIds ?? null,
      caption: input.caption ?? null,
      publishChatId: input.publishChatId ?? null,
      publishThreadId: input.publishThreadId ?? null,
      status: input.status ?? 'pending',
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
      decidedAt: null,
      decidedBy: null,
      publishedMessageId: null,
      lastError: input.error ?? null,
    };
    this.reviews.set(record.id, record);
    return { record, created: true };
  }

  async getReview(reviewId: string): Promise<ReviewRecord | null> {
    const review = this.reviews.get(reviewId);
    return review ? clone(review) : null;
  }

  async listPendingReviews(limit: number): Promise<ReviewRecord[]> {
    return [...this.reviews.values()]
      .filter((review) => review.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit)
      .map(clone);
  }

  async transitionReview(input: {
    reviewId: string;
    from: ReviewStatus;
    to: ReviewStatus;
    nowMs: number;
    actor?: string | null;
    error?: string | null;
  }): Promise<boolean> {
    const review = this.reviews.get(input.reviewId);
    if (!review || review.status !== input.from) return false;
    review.status = input.to;
    review.updatedAt = input.nowMs;
    if (input.error) review.lastError = input.error;
    if (input.from === 'pending') {
      review.decidedAt = input.nowMs;
      review.decidedBy = input.actor ?? null;
    }
    return true;
  }

  /** Mirrors the D1 claim: one conditional UPDATE, stale branch included. */
  async claimReviewForPublishing(input: {
    reviewId: string;
    nowMs: number;
    staleMs: number;
  }): Promise<{ claimed: boolean; record: ReviewRecord | null }> {
    const review = this.reviews.get(input.reviewId);
    if (!review) return { claimed: false, record: null };
    const claimable =
      CLAIMABLE_REVIEW_STATUSES.includes(review.status) ||
      (review.status === 'publishing' && input.nowMs - review.updatedAt > input.staleMs);
    if (claimable) {
      review.status = 'publishing';
      review.updatedAt = input.nowMs;
    }
    // D1 returns a snapshot, so the fake must hand back a copy for the same reason.
    return { claimed: claimable, record: { ...review } };
  }

  async recordPublishedMessage(input: {
    reviewId: string;
    publishedMessageId: number | null;
    nowMs: number;
  }): Promise<boolean> {
    const review = this.reviews.get(input.reviewId);
    if (!review || review.status !== 'publishing') return false;
    review.publishedMessageId = input.publishedMessageId;
    review.updatedAt = input.nowMs;
    return true;
  }

  async listStalePublishing(input: { olderThanMs: number; limit: number }): Promise<ReviewRecord[]> {
    return [...this.reviews.values()]
      .filter((review) => review.status === 'publishing' && review.updatedAt <= input.olderThanMs)
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, input.limit)
      .map((review) => ({ ...review }));
  }

  async markReviewPublished(input: {
    reviewId: string;
    publishedMessageId: number | null;
    nowMs: number;
    actor?: string | null;
  }): Promise<boolean> {
    const review = this.reviews.get(input.reviewId);
    // Guarded: a late writer must not clobber a row another actor resolved.
    if (!review || review.status !== 'publishing') return false;
    review.status = 'published';
    review.publishedMessageId = input.publishedMessageId;
    review.decidedAt = input.nowMs;
    if (input.actor != null) review.decidedBy = input.actor;
    review.updatedAt = input.nowMs;
    return true;
  }

  // ---- runner credentials ---------------------------------------------------

  readonly credentials = new Map<
    string,
    { value: string; updatedAt: number; previousHash: string | null; rotations: number }
  >();

  async getRunnerCredential(name: string): Promise<RunnerCredentialRow | null> {
    const row = this.credentials.get(name);
    if (!row) return null;
    return {
      name,
      updatedAt: row.updatedAt,
      previousHash: row.previousHash,
      rotations: row.rotations,
    };
  }

  async readRunnerCredentialSecret(name: string): Promise<RunnerCredentialSecret | null> {
    const row = this.credentials.get(name);
    if (!row) return null;
    return { name, ...row };
  }

  async listRunnerCredentials(): Promise<RunnerCredentialRow[]> {
    return [...this.credentials.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, row]) => ({
        name,
        updatedAt: row.updatedAt,
        previousHash: row.previousHash,
        rotations: row.rotations,
      }));
  }

  async deleteRunnerCredential(name: string): Promise<boolean> {
    return this.credentials.delete(name);
  }

  async putRunnerCredential(input: {
    name: string;
    value: string;
    nowMs: number;
  }): Promise<{ stored: true; changed: boolean; rotations: number }> {
    const existing = this.credentials.get(input.name);
    // Same value again is not a rotation: a runner echoing what it was given must
    // not appear as one in the audit trail.
    const changed = existing !== undefined && existing.value !== input.value;
    const rotations = existing === undefined ? 0 : existing.rotations + (changed ? 1 : 0);
    this.credentials.set(input.name, {
      value: input.value,
      updatedAt: input.nowMs,
      // Real digest, same as D1: a fake that roughly approximates the store has
      // already hidden one real bug in this suite.
      previousHash: changed ? await hashSecret(existing!.value) : (existing?.previousHash ?? null),
      rotations,
    });
    return { stored: true, changed, rotations };
  }

  // ---- processed works ------------------------------------------------------

  readonly processed = new Set<string>();
  readonly processedRows: Array<{ workType: string; pixivId: string; botId: string }> = [];

  async recordProcessedWorks(input: {
    botId: string;
    slotId?: string | null;
    works: Array<{ workType: string; pixivId: string; targetId?: string | null }>;
    nowMs: number;
  }): Promise<number> {
    let created = 0;
    for (const work of input.works) {
      const key = `${input.botId}|${work.workType}|${work.pixivId}`;
      if (this.processed.has(key)) continue;
      this.processed.add(key);
      this.processedRows.push({ ...work, botId: input.botId });
      created += 1;
    }
    return created;
  }

  async listProcessedWorks(
    botId: string,
    limit: number
  ): Promise<Array<{ workType: string; pixivId: string }>> {
    return this.processedRows
      .filter((row) => row.botId === botId)
      .slice(-limit)
      .reverse()
      .map((row) => ({ workType: row.workType, pixivId: row.pixivId }));
  }

  // ---- test helpers ---------------------------------------------------------

  get createdSlotCount(): number {
    return this.createdSlots;
  }
  get createdExecutionCount(): number {
    return this.createdExecutions;
  }

  setSlotStatusDirect(slotId: string, status: SlotStatus): void {
    this.requireSlot(slotId).status = status;
  }

  eventsNamed(event: string): EventRecord[] {
    return this.events.filter((entry) => entry.event === event);
  }

  private requireSlot(slotId: string): OccurrenceRow {
    const row = this.slots.get(slotId);
    if (!row) throw new Error(`unknown slot ${slotId}`);
    return row;
  }
}

/** Fake execution provider: scripted provider state, no network. */
export class FakeProvider implements ExecutionProvider {
  readonly name = 'fake';
  dispatched: Array<{ slotId: string; attempt: number }> = [];
  runs = new Map<string, ProviderRun>();
  recent: ProviderRun[] = [];
  /** Every dispatch request this fake saw, in order. */
  readonly dispatches: Array<{ slotId: string; credentialKey: string; attempt: number; ref: string }> = [];
  acceptDispatch = true;
  dispatchError: string | undefined;
  /** Simulate a provider whose dispatch throws (network failure, runtime bug). */
  throwOnDispatch: string | undefined;
  cancelCalls: string[] = [];
  /**
   * Clock used to stamp provider runs. Tests set this to their fixed "now" so
   * run-time filters (listRecentRuns) behave like production rather than like the
   * wall clock of the test process.
   */
  nowMs = Date.parse('2026-09-11T10:05:00Z');
  private nextRun = 1;

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    this.dispatched.push({ slotId: request.slotId, attempt: request.attempt });
    if (this.throwOnDispatch) throw new Error(this.throwOnDispatch);
    if (!this.acceptDispatch) {
      return { accepted: false, ...(this.dispatchError ? { detail: this.dispatchError } : {}) };
    }
    const runId = String(this.nextRun++);
    const run: ProviderRun = {
      runId,
      state: 'queued',
      conclusion: null,
      createdAt: this.nowMs,
    };
    this.runs.set(runId, run);
    this.dispatches.push({
      slotId: request.slotId,
      credentialKey: request.credentialKey,
      attempt: request.attempt,
      ref: request.pixivflowRef,
    });
    this.recent.push(run);
    return { accepted: true };
  }

  async getRun(runId: string): Promise<ProviderRun> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  async cancel(runId: string): Promise<void> {
    this.cancelCalls.push(runId);
  }

  async listRecentRuns(sinceMs: number): Promise<ProviderRun[]> {
    return this.recent.filter((run) => (run.createdAt ?? 0) >= sinceMs);
  }

  // ---- test helpers ---------------------------------------------------------

  /** Move the provider's newest run to a terminal state. */
  concludeLastRun(state: ProviderRunState, conclusion: ProviderConclusion): void {
    const runs = [...this.runs.values()];
    const last = runs[runs.length - 1];
    if (!last) throw new Error('no run to conclude');
    last.state = state;
    last.conclusion = conclusion;
  }

  setRunState(runId: string, state: ProviderRunState): void {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    run.state = state;
  }
}
