/**
 * D1 implementation of the control-plane storage port.
 *
 * Deliberately thin: SQL only, no business rules. Every rule lives in
 * reconciliation.ts so it can be tested without Cloudflare.
 */

import type { Occurrence } from './occurrences';
import type {
  ControlPlaneStore,
  EventRecord,
  ExecutionRow,
  ExecutionStatus,
  ItemStatus,
  OccurrenceRow,
  ReconciliationSummary,
  ReviewRecord,
  ReviewStatus,
  SlotItemInput,
  SlotItemRow,
  SlotStatus,
} from './store';
import { isTerminalExecution, TERMINAL_ITEM_STATUSES } from './store';

/**
 * The subset of the D1 API this worker uses, declared structurally so the store
 * can also be driven by a fake in tests and so the types never leak Cloudflare
 * specifics into the state machine.
 */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}

export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

interface SlotRowDb {
  id: string;
  schedule_id: string;
  bot_id: string;
  occurrence_at: number;
  status: string;
  attempt_count: number;
  dispatch_deadline: number | null;
  current_execution_id: string | null;
  dispatched_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  last_error: string | null;
}

function toRow(row: SlotRowDb): OccurrenceRow {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    botId: row.bot_id,
    occurrenceAt: row.occurrence_at,
    status: row.status as SlotStatus,
    attemptCount: row.attempt_count,
    dispatchDeadline: row.dispatch_deadline,
    currentExecutionId: row.current_execution_id,
    dispatchedAt: row.dispatched_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    lastError: row.last_error,
  };
}

const SLOT_COLUMNS = `id, schedule_id, bot_id, occurrence_at, status, attempt_count,
  dispatch_deadline, current_execution_id, dispatched_at, started_at, completed_at, last_error`;

interface ExecutionRowDb {
  id: string;
  slot_id: string;
  attempt: number;
  provider: string;
  provider_run_id: string | null;
  status: string;
  created_at: number;
  dispatched_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  error_class: string | null;
  result: string | null;
}

const EXECUTION_COLUMNS = `id, slot_id, attempt, provider, provider_run_id, status, created_at,
  dispatched_at, started_at, completed_at, error, error_class, result`;

interface ReviewRowDb {
  id: string;
  bot_id: string;
  slot_id: string | null;
  target_id: string | null;
  work_id: string | null;
  chat_id: string;
  message_id: number | null;
  message_ids: string | null;
  media_group_id: string | null;
  file_ids: string | null;
  caption: string | null;
  publish_chat_id: string | null;
  publish_thread_id: number | null;
  status: string;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
  published_message_id: number | null;
  last_error: string | null;
}

const REVIEW_COLUMNS = `id, bot_id, slot_id, target_id, work_id, chat_id, message_id, message_ids,
  media_group_id, file_ids, caption, publish_chat_id, publish_thread_id, status, created_at, updated_at,
  decided_at, decided_by, published_message_id, last_error`;

function parseNumberArray(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number') : null;
  } catch {
    return null;
  }
}

function parseStringArray(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : null;
  } catch {
    return null;
  }
}

function toReview(row: ReviewRowDb): ReviewRecord {
  return {
    id: row.id,
    botId: row.bot_id,
    slotId: row.slot_id,
    targetId: row.target_id,
    workId: row.work_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    messageIds: parseNumberArray(row.message_ids),
    mediaGroupId: row.media_group_id,
    fileIds: parseStringArray(row.file_ids),
    caption: row.caption,
    publishChatId: row.publish_chat_id,
    publishThreadId: row.publish_thread_id,
    status: row.status as ReviewStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    publishedMessageId: row.published_message_id,
    lastError: row.last_error,
  };
}

function toExecution(row: ExecutionRowDb): ExecutionRow {
  return {
    id: row.id,
    slotId: row.slot_id,
    attempt: row.attempt,
    provider: row.provider,
    providerRunId: row.provider_run_id,
    status: row.status as ExecutionStatus,
    createdAt: row.created_at,
    dispatchedAt: row.dispatched_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    errorClass: row.error_class,
    result: row.result,
  };
}

export class D1ControlStore implements ControlPlaneStore {
  constructor(private readonly db: D1Like) {}

  async insertOccurrenceIfAbsent(occurrence: Occurrence, nowMs: number): Promise<'created' | 'exists'> {
    // `INSERT OR IGNORE` on the unique (schedule_id, occurrence_at) key is the
    // first idempotency layer: concurrent sweeps and duplicate clocks converge
    // onto one row instead of racing.
    const result = (await this.db
      .prepare(
        `INSERT OR IGNORE INTO slot_occurrences
           (id, schedule_id, bot_id, occurrence_at, occurrence_date, occurrence_label, timezone,
            status, attempt_count, created_at, dispatch_deadline)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
      )
      .bind(
        occurrence.slotId,
        occurrence.scheduleId,
        occurrence.botId,
        occurrence.occurrenceAt,
        occurrence.occurrenceDate,
        occurrence.occurrenceLabel,
        occurrence.timezone,
        nowMs,
        occurrence.dispatchDeadline
      )
      .run()) as { meta?: { changes?: number } } | undefined;
    const changes = result?.meta?.changes ?? 0;
    return changes > 0 ? 'created' : 'exists';
  }

  async listActiveOccurrences(fromMs: number, toMs: number): Promise<OccurrenceRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${SLOT_COLUMNS} FROM slot_occurrences
          WHERE status IN ('pending','dispatched','running','uncertain')
            AND occurrence_at >= ? AND occurrence_at <= ?
          ORDER BY occurrence_at ASC`
      )
      .bind(fromMs, toMs)
      .all<SlotRowDb>();
    return (results ?? []).map(toRow);
  }

  async listRecentOccurrences(limit: number): Promise<OccurrenceRow[]> {
    const { results } = await this.db
      .prepare(`SELECT ${SLOT_COLUMNS} FROM slot_occurrences ORDER BY occurrence_at DESC LIMIT ?`)
      .bind(limit)
      .all<SlotRowDb>();
    return (results ?? []).map(toRow);
  }

  async countByStatus(): Promise<Record<string, number>> {
    const { results } = await this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM slot_occurrences GROUP BY status`)
      .all<{ status: string; n: number }>();
    const counts: Record<string, number> = {};
    for (const row of results ?? []) counts[row.status] = row.n;
    return counts;
  }

  async markExpired(slotId: string, reason: string, nowMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slot_occurrences
            SET status = 'expired', completed_at = ?, last_error = ?
          WHERE id = ? AND status NOT IN ('success','partial','failed','cancelled','expired')`
      )
      .bind(nowMs, reason, slotId)
      .run();
  }

  async recordReconciliation(input: {
    id: string;
    startedAt: number;
    finishedAt: number;
    summary: ReconciliationSummary;
  }): Promise<void> {
    const { summary } = input;
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO reconciliation_runs
           (id, started_at, finished_at, created_slots, dispatched, reconciled, retried, expired, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.startedAt,
        input.finishedAt,
        summary.created,
        summary.dispatched,
        summary.reconciled,
        summary.retried,
        summary.expired,
        summary.errors.length > 0 ? JSON.stringify(summary.errors) : null
      )
      .run();
  }

  async logEvents(events: EventRecord[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.batch(
      events.map((event) =>
        this.db
          .prepare(
            `INSERT INTO event_log (ts, event, slot_id, schedule_id, execution_id, attempt, provider_run_id, target_id, bot_id, detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            event.ts,
            event.event,
            event.slotId ?? null,
            event.scheduleId ?? null,
            event.executionId ?? null,
            event.attempt ?? null,
            event.providerRunId ?? null,
            event.targetId ?? null,
            event.botId ?? null,
            event.detail ?? null
          )
      )
    );
  }

  // ---- executions -----------------------------------------------------------

  async openExecution(input: {
    id: string;
    slotId: string;
    attempt: number;
    provider: string;
    nowMs: number;
  }): Promise<'created' | 'exists'> {
    // Unique (slot_id, attempt) is the anti-duplicate-dispatch layer: two
    // concurrent sweeps, a retried request or a replayed clock all converge on
    // one execution row instead of opening a second runner for the same attempt.
    const result = (await this.db
      .prepare(
        `INSERT OR IGNORE INTO executions (id, slot_id, attempt, provider, status, created_at)
         VALUES (?, ?, ?, ?, 'dispatching', ?)`
      )
      .bind(input.id, input.slotId, input.attempt, input.provider, input.nowMs)
      .run()) as { meta?: { changes?: number } } | undefined;
    return (result?.meta?.changes ?? 0) > 0 ? 'created' : 'exists';
  }

  async getExecution(executionId: string): Promise<ExecutionRow | null> {
    const row = await this.db
      .prepare(`SELECT ${EXECUTION_COLUMNS} FROM executions WHERE id = ?`)
      .bind(executionId)
      .first<ExecutionRowDb>();
    return row ? toExecution(row) : null;
  }

  async latestExecutionForSlot(slotId: string): Promise<ExecutionRow | null> {
    const row = await this.db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM executions WHERE slot_id = ? ORDER BY attempt DESC LIMIT 1`
      )
      .bind(slotId)
      .first<ExecutionRowDb>();
    return row ? toExecution(row) : null;
  }

  async listOpenExecutions(limit: number): Promise<ExecutionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM executions
          WHERE status IN ('dispatching','dispatched','running')
          ORDER BY created_at ASC LIMIT ?`
      )
      .bind(limit)
      .all<ExecutionRowDb>();
    return (results ?? []).map(toExecution);
  }

  async listUnclaimedExecutions(olderThanMs: number, limit: number): Promise<ExecutionRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${EXECUTION_COLUMNS} FROM executions
          WHERE status = 'dispatched' AND provider_run_id IS NULL AND created_at <= ?
          ORDER BY created_at ASC LIMIT ?`
      )
      .bind(olderThanMs, limit)
      .all<ExecutionRowDb>();
    return (results ?? []).map(toExecution);
  }

  async attachProviderRun(executionId: string, providerRunId: string, nowMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE executions SET provider_run_id = ?, status = 'dispatched', dispatched_at = ?
          WHERE id = ? AND status = 'dispatching'`
      )
      .bind(providerRunId, nowMs, executionId)
      .run();
  }

  async markExecutionRunning(executionId: string, providerRunId: string | null, nowMs: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE executions
            SET status = 'running',
                started_at = COALESCE(started_at, ?),
                provider_run_id = COALESCE(?, provider_run_id)
          WHERE id = ? AND status IN ('dispatching','dispatched','running')`
      )
      .bind(nowMs, providerRunId, executionId)
      .run();
  }

  async markExecutionTerminal(input: {
    executionId: string;
    status: ExecutionStatus;
    nowMs: number;
    error?: string;
    errorClass?: string;
    result?: string;
  }): Promise<void> {
    // Write-once: a replayed/duplicate callback must not overwrite a terminal
    // row (that is what makes approve/result callbacks idempotent).
    await this.db
      .prepare(
        `UPDATE executions
            SET status = ?, completed_at = ?, error = ?, error_class = ?, result = ?
          WHERE id = ?
            AND status NOT IN ('success','partial','failed','cancelled','timeout','uncertain')`
      )
      .bind(
        input.status,
        input.nowMs,
        input.error ?? null,
        input.errorClass ?? null,
        input.result ?? null,
        input.executionId
      )
      .run();
  }

  async setSlotStatus(
    slotId: string,
    status: SlotStatus,
    nowMs: number,
    options: { error?: string; currentExecutionId?: string | null; startedAt?: number; completedAt?: number } = {}
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE slot_occurrences
            SET status = ?,
                current_execution_id = COALESCE(?, current_execution_id),
                last_error = COALESCE(?, last_error),
                started_at = COALESCE(?, started_at),
                completed_at = COALESCE(?, completed_at),
                dispatched_at = CASE WHEN ? = 'dispatched' THEN COALESCE(dispatched_at, ?) ELSE dispatched_at END,
                attempt_count = CASE WHEN ? = 'dispatched' THEN attempt_count + 1 ELSE attempt_count END
          WHERE id = ?`
      )
      .bind(
        status,
        options.currentExecutionId ?? null,
        options.error ?? null,
        options.startedAt ?? null,
        options.completedAt ?? null,
        status,
        nowMs,
        status,
        slotId
      )
      .run();
  }

  async getOccurrence(slotId: string): Promise<OccurrenceRow | null> {
    const row = await this.db
      .prepare(`SELECT ${SLOT_COLUMNS} FROM slot_occurrences WHERE id = ?`)
      .bind(slotId)
      .first<SlotRowDb>();
    return row ? toRow(row) : null;
  }

  async countExecutionsForSlot(slotId: string): Promise<number> {
    const row = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM executions WHERE slot_id = ?`)
      .bind(slotId)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** True when the execution is already terminal (used by idempotent callbacks). */
  static isTerminal(status: ExecutionStatus): boolean {
    return isTerminalExecution(status);
  }

  // ---- reviews (edge review adapter) ----------------------------------------

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
    /**
     * A review whose media may have reached the chat but whose outcome is unknown
     * is recorded as `uncertain` from the start: that is what stops a retry from
     * posting a second copy (the runner's pre-flight check finds it and stops).
     */
    status?: 'pending' | 'uncertain';
    error?: string | null;
    nowMs: number;
  }): Promise<{ record: ReviewRecord; created: boolean }> {
    // (bot_id, target_id, work_id) is unique, so a retried runner callback — or a
    // second runner racing the same slot — converges on one review instead of
    // creating a second pending decision for the same work.
    const inserted = (await this.db
      .prepare(
        `INSERT OR IGNORE INTO reviews
           (id, bot_id, slot_id, target_id, work_id, chat_id, message_id, message_ids, media_group_id,
            file_ids, caption, publish_chat_id, publish_thread_id, status, created_at, updated_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.botId,
        input.slotId ?? null,
        input.targetId ?? null,
        input.workId ?? null,
        input.chatId,
        input.messageId ?? null,
        input.messageIds ? JSON.stringify(input.messageIds) : null,
        input.mediaGroupId ?? null,
        input.fileIds ? JSON.stringify(input.fileIds) : null,
        input.caption ?? null,
        input.publishChatId ?? null,
        input.publishThreadId ?? null,
        input.status ?? 'pending',
        input.nowMs,
        input.nowMs,
        input.error ?? null
      )
      .run()) as { meta?: { changes?: number } } | undefined;

    const row = await this.db
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE bot_id = ? AND target_id IS ? AND work_id IS ?`
      )
      .bind(input.botId, input.targetId ?? null, input.workId ?? null)
      .first<ReviewRowDb>();
    if (!row) throw new Error(`review row not found after insert: ${input.id}`);
    return { record: toReview(row), created: (inserted?.meta?.changes ?? 0) > 0 };
  }

  async getReview(reviewId: string): Promise<ReviewRecord | null> {
    const row = await this.db
      .prepare(`SELECT ${REVIEW_COLUMNS} FROM reviews WHERE id = ?`)
      .bind(reviewId)
      .first<ReviewRowDb>();
    return row ? toReview(row) : null;
  }

  async listPendingReviews(limit: number): Promise<ReviewRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`
      )
      .bind(limit)
      .all<ReviewRowDb>();
    return (results ?? []).map(toReview);
  }

  async transitionReview(input: {
    reviewId: string;
    from: ReviewStatus;
    to: ReviewStatus;
    nowMs: number;
    actor?: string | null;
    error?: string | null;
  }): Promise<boolean> {
    // Compare-and-set: the WHERE clause on the expected status is what makes two
    // concurrent callbacks elect exactly one deciding caller.
    const result = (await this.db
      .prepare(
        `UPDATE reviews
            SET status = ?, updated_at = ?, last_error = COALESCE(?, last_error),
                decided_at = CASE WHEN ? = 'pending' THEN ? ELSE decided_at END,
                decided_by = CASE WHEN ? = 'pending' THEN COALESCE(?, decided_by) ELSE decided_by END
          WHERE id = ? AND status = ?`
      )
      .bind(
        input.to,
        input.nowMs,
        input.error ?? null,
        input.from,
        input.nowMs,
        input.from,
        input.actor ?? null,
        input.reviewId,
        input.from
      )
      .run()) as { meta?: { changes?: number } } | undefined;
    return (result?.meta?.changes ?? 0) > 0;
  }

  async markReviewPublished(input: {
    reviewId: string;
    publishedMessageId: number | null;
    nowMs: number;
  }): Promise<void> {
    await this.db
      .prepare(`UPDATE reviews SET published_message_id = ?, updated_at = ? WHERE id = ?`)
      .bind(input.publishedMessageId, input.nowMs, input.reviewId)
      .run();
  }

  // ---- slot items -----------------------------------------------------------

  async upsertSlotItem(input: {
    slotId: string;
    botId: string;
    item: SlotItemInput;
    nowMs: number;
  }): Promise<'created' | 'updated' | 'skipped-terminal'> {
    const existing = await this.db
      .prepare(`SELECT status, work_type, work_id, attempt_count, created_at FROM slot_items WHERE slot_id = ? AND target_id = ?`)
      .bind(input.slotId, input.item.targetId)
      .first<{ status: string; work_type: string; work_id: string | null; attempt_count: number; created_at: number }>();

    const terminal = existing ? TERMINAL_ITEM_STATUSES.includes(existing.status as ItemStatus) : false;
    if (terminal) {
      // Never overwrite a target that already reached a terminal state: a retry
      // of the sibling target, or a later execution attempt, must not erase it.
      return 'skipped-terminal';
    }

    const completedAt = existing && TERMINAL_ITEM_STATUSES.includes(input.item.status) ? input.nowMs : null;

    if (!existing) {
      await this.db
        .prepare(
          `INSERT INTO slot_items
             (slot_id, target_id, bot_id, work_type, work_id, status, attempt_count, last_error, error_class,
              created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .bind(
          input.slotId,
          input.item.targetId,
          input.botId,
          input.item.workType ?? 'unknown',
          input.item.workId ?? null,
          input.item.status,
          input.item.error ?? null,
          input.item.errorClass ?? null,
          input.nowMs,
          input.nowMs,
          completedAt
        )
        .run();
      return 'created';
    }

    await this.db
      .prepare(
        `UPDATE slot_items
            SET status = ?, work_id = COALESCE(?, work_id), attempt_count = attempt_count + 1,
                last_error = ?, error_class = ?, updated_at = ?, completed_at = COALESCE(?, completed_at)
          WHERE slot_id = ? AND target_id = ?`
      )
      .bind(
        input.item.status,
        input.item.workId ?? null,
        input.item.error ?? null,
        input.item.errorClass ?? null,
        input.nowMs,
        completedAt,
        input.slotId,
        input.item.targetId
      )
      .run();
    return 'updated';
  }

  async listSlotItems(slotId: string): Promise<SlotItemRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT slot_id, target_id, bot_id, work_type, work_id, status, attempt_count, last_error, error_class,
                created_at, updated_at, completed_at
           FROM slot_items WHERE slot_id = ? ORDER BY target_id ASC`
      )
      .bind(slotId)
      .all<{
        slot_id: string;
        target_id: string;
        bot_id: string;
        work_type: string;
        work_id: string | null;
        status: string;
        attempt_count: number;
        last_error: string | null;
        error_class: string | null;
        created_at: number;
        updated_at: number;
        completed_at: number | null;
      }>();
    return (results ?? []).map((row) => ({
      slotId: row.slot_id,
      targetId: row.target_id,
      botId: row.bot_id,
      workType: row.work_type,
      workId: row.work_id,
      status: row.status as ItemStatus,
      attemptCount: row.attempt_count,
      lastError: row.last_error,
      errorClass: row.error_class,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    }));
  }
}
