/**
 * D1 implementation of the control-plane storage port.
 *
 * Deliberately thin: SQL only, no business rules. Every rule lives in
 * reconciliation.ts so it can be tested without Cloudflare.
 */

import type { Occurrence } from './occurrences';
import type {
  ControlStore,
  EventRecord,
  OccurrenceRow,
  ReconciliationSummary,
  SlotStatus,
} from './store';

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

export class D1ControlStore implements ControlStore {
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
}
