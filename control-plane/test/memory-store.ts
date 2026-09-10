/**
 * In-memory ControlPlaneStore used by the control-plane tests.
 *
 * It mirrors the semantics the D1 store guarantees (unique keys, write-once
 * terminal transitions, terminal items win) so the state machine and the failure
 * injection tests exercise real rules rather than a convenient fake.
 */

import type { Occurrence } from '../src/occurrences';
import type {
  DispatchRequest,
  DispatchResult,
  ExecutionProvider,
  ProviderConclusion,
  ProviderRun,
  ProviderRunState,
} from '../src/provider';
import {
  isTerminalExecution,
  TERMINAL_ITEM_STATUSES,
  type ControlPlaneStore,
  type EventRecord,
  type ExecutionRow,
  type ExecutionStatus,
  type ItemStatus,
  type OccurrenceRow,
  type ReconciliationSummary,
  type ReviewRecord,
  type ReviewStatus,
  type SlotItemInput,
  type SlotItemRow,
  type SlotStatus,
} from '../src/store';

export class MemoryControlStore implements ControlPlaneStore {
  readonly slots = new Map<string, OccurrenceRow>();
  readonly executions = new Map<string, ExecutionRow>();
  readonly items = new Map<string, SlotItemRow>();
  readonly events: EventRecord[] = [];
  readonly runs: ReconciliationSummary[] = [];

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
      .sort((a, b) => a.occurrenceAt - b.occurrenceAt);
  }

  async listRecentOccurrences(limit: number): Promise<OccurrenceRow[]> {
    return [...this.slots.values()].sort((a, b) => b.occurrenceAt - a.occurrenceAt).slice(0, limit);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.slots.values()) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }

  async markExpired(slotId: string, reason: string, nowMs: number): Promise<void> {
    const row = this.requireSlot(slotId);
    if (['success', 'partial', 'failed', 'cancelled', 'expired'].includes(row.status)) return;
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
    return this.executions.get(executionId) ?? null;
  }

  async latestExecutionForSlot(slotId: string): Promise<ExecutionRow | null> {
    const rows = [...this.executions.values()].filter((row) => row.slotId === slotId);
    return rows.sort((a, b) => b.attempt - a.attempt)[0] ?? null;
  }

  async listOpenExecutions(limit: number): Promise<ExecutionRow[]> {
    return [...this.executions.values()]
      .filter((row) => !isTerminalExecution(row.status))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
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
    return this.slots.get(slotId) ?? null;
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
    if (existing && TERMINAL_ITEM_STATUSES.includes(existing.status)) return 'skipped-terminal';

    if (!existing) {
      this.items.set(key, {
        slotId: input.slotId,
        targetId: input.item.targetId,
        botId: input.botId,
        workType: input.item.workType ?? 'unknown',
        workId: input.item.workId ?? null,
        status: input.item.status,
        attemptCount: 1,
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
    existing.attemptCount += 1;
    existing.lastError = input.item.error ?? null;
    existing.errorClass = input.item.errorClass ?? null;
    existing.updatedAt = input.nowMs;
    if (TERMINAL_ITEM_STATUSES.includes(input.item.status)) existing.completedAt = input.nowMs;
    return 'updated';
  }

  async listSlotItems(slotId: string): Promise<SlotItemRow[]> {
    return [...this.items.values()].filter((row) => row.slotId === slotId);
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
    nowMs: number;
  }): Promise<{ record: ReviewRecord; created: boolean }> {
    // Mirrors the D1 unique index on (bot_id, target_id, work_id).
    const existing = [...this.reviews.values()].find(
      (review) =>
        review.botId === input.botId &&
        review.targetId === (input.targetId ?? null) &&
        review.workId === (input.workId ?? null)
    );
    if (existing) return { record: existing, created: false };

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
      status: 'pending',
      createdAt: input.nowMs,
      updatedAt: input.nowMs,
      decidedAt: null,
      decidedBy: null,
      publishedMessageId: null,
      lastError: null,
    };
    this.reviews.set(record.id, record);
    return { record, created: true };
  }

  async getReview(reviewId: string): Promise<ReviewRecord | null> {
    return this.reviews.get(reviewId) ?? null;
  }

  async listPendingReviews(limit: number): Promise<ReviewRecord[]> {
    return [...this.reviews.values()]
      .filter((review) => review.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
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

  async markReviewPublished(input: {
    reviewId: string;
    publishedMessageId: number | null;
    nowMs: number;
  }): Promise<void> {
    const review = this.reviews.get(input.reviewId);
    if (!review) return;
    review.publishedMessageId = input.publishedMessageId;
    review.updatedAt = input.nowMs;
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
