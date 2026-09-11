/**
 * Operator recovery attempts.
 *
 * The scenario these tests encode is a real incident: the legacy Fly watchdog woke
 * the old execution plane, both planes shared one `pixiv-main`, every attempt died
 * in Pixiv rate-limit cooldown, and `bot1-daily@2026-09-11T1000` reached `failed`
 * with 3/3 attempts spent while the occurrence itself was fine. Recovery must give
 * it a fourth attempt WITHOUT pretending the first three never happened.
 */

import { describe, expect, it } from 'vitest';

import { MemoryControlStore, FakeProvider } from './memory-store';
import { recoverOccurrence, assessRecovery, refusalEvent } from '../src/recovery';
import { reconcileAll } from '../src/reconciliation';
import { PIXIV_CREDENTIAL } from '../src/schedules';
import type { Occurrence } from '../src/occurrences';

const NOW = Date.parse('2026-09-11T04:30:00Z');
const OCCURRENCE_AT = Date.parse('2026-09-11T02:00:00Z');
const SLOT = 'bot1-daily@2026-09-11T1000';

const SCHEDULES_UNDER_TEST = [
  {
    id: 'bot1-daily',
    botId: 'bot1',
    times: ['10:00'],
    timezone: 'Asia/Shanghai',
    targets: [{ id: 'bot1-illust', workType: 'illustration' as const }],
    credential: PIXIV_CREDENTIAL,
    dispatchDeadlineHours: 6,
    maxAttempts: 3,
  },
  {
    id: 'bot2-daily',
    botId: 'bot2',
    times: ['10:10'],
    timezone: 'Asia/Shanghai',
    targets: [{ id: 'bot2-illust', workType: 'illustration' as const }],
    credential: PIXIV_CREDENTIAL,
    dispatchDeadlineHours: 6,
    maxAttempts: 3,
  },
];

const DEPLOY = { mode: 'live' as const, callbackUrl: 'https://cp.test/control', pixivflowRef: 'master' };

const RECOVERY_INPUT = {
  slotId: SLOT,
  reason: 'legacy Fly watchdog competed for pixiv-main and exhausted automatic attempts',
  actor: 'operator',
  nowMs: NOW,
  maxAutomaticAttempts: 3,
  dispatchDeadlineHours: 6,
  dryRun: false,
};

function occurrence(slotId = SLOT, scheduleId = 'bot1-daily', botId = 'bot1'): Occurrence {
  return {
    slotId,
    scheduleId,
    botId,
    occurrenceAt: OCCURRENCE_AT,
    occurrenceDate: '2026-09-11',
    occurrenceLabel: '10:00',
    timezone: 'Asia/Shanghai',
    dispatchDeadline: OCCURRENCE_AT + 6 * 60 * 60 * 1000,
  };
}

/**
 * A slot that spent all three automatic attempts and ended terminal `failed`.
 *
 * Creates real execution rows, not just slot status: the point of the incident is
 * that three genuine attempts, their errors and their audits survived, so a helper
 * that only flipped a status would let the tests assert something the ledger never
 * held.
 */
async function exhausted(store: MemoryControlStore, slotId = SLOT, upTo = 3): Promise<void> {
  const scheduleId = slotId.startsWith('bot2') ? 'bot2-daily' : 'bot1-daily';
  const botId = slotId.startsWith('bot2') ? 'bot2' : 'bot1';
  await store.insertOccurrenceIfAbsent(occurrence(slotId, scheduleId, botId), OCCURRENCE_AT);
  for (let attempt = 1; attempt <= upTo; attempt += 1) {
    const executionId = `${slotId}#${attempt}`;
    await store.openExecution({ id: executionId, slotId, attempt, provider: 'fake', nowMs: NOW });
    await store.markExecutionRunning(executionId, 'run-' + attempt, NOW);
    await store.setSlotStatus(slotId, 'dispatched', NOW);
    await store.markExecutionTerminal({
      executionId,
      status: 'failed',
      nowMs: NOW,
      error: `attempt ${attempt}: run exceeded 1800000ms watchdog; download cancelled`,
      errorClass: 'download_failed',
    });
    await store.setSlotStatus(slotId, 'failed', NOW, { error: 'download_failed' });
  }
}

async function reviewFor(store: MemoryControlStore, status: string, published: boolean) {
  return store.createReview({
    id: `review-${status}-${published}`,
    botId: 'bot1',
    slotId: SLOT,
    targetId: 'bot1-illust',
    chatId: '-100',
    status: status as never,
    ...(published ? { publishedMessageId: 999 } : {}),
  } as never);
}

describe('eligibility: only a terminal, side-effect-free occurrence', () => {
  it('allows a failed 3/3 occurrence and reports attempt 4 without renumbering', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });

    expect(report.eligible).toBe(true);
    expect(report.refusal).toBeNull();
    expect(report.currentStatus).toBe('failed');
    expect(report.attemptsUsed).toBe(3);
    expect(report.nextAttempt).toBe(4);
    expect(report.activeExecutions).toBe(0);
    expect(report.uncertainReviews).toBe(0);
    expect(report.publishedSideEffects).toBe(0);
  });

  it('refuses success', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await store.setSlotStatus(SLOT, 'success', NOW);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('status_not_recoverable');
  });

  it('refuses uncertain', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await store.setSlotStatus(SLOT, 'uncertain', NOW);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('status_not_recoverable');
  });

  it('refuses a running occurrence', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await store.setSlotStatus(SLOT, 'running', NOW);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('status_not_recoverable');
  });

  it('refuses when an execution still holds the occurrence', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    // A live attempt left behind: granting another would put two runs on one
    // credential and one set of side effects.
    await store.openExecution({ id: 'e-open', slotId: SLOT, attempt: 4, provider: 'fake', nowMs: NOW });

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('active_execution');
    expect(report.activeExecutions).toBe(1);
  });

  it('refuses when a review was already published', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await reviewFor(store, 'published', true);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('published_side_effect');
    expect(report.publishedSideEffects).toBe(1);
  });

  it('refuses an unresolved uncertain review', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await reviewFor(store, 'uncertain', false);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('unresolved_uncertain_review');
    expect(report.uncertainReviews).toBe(1);
  });

  it('refuses an undecided review that a rerun would duplicate', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await reviewFor(store, 'pending', false);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('open_review_would_duplicate');
  });

  it('refuses without a stated reason', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);

    const report = await assessRecovery(store, { ...RECOVERY_INPUT, reason: '   ', dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('reason_required');
  });

  it('refuses an unknown occurrence', async () => {
    const store = new MemoryControlStore();
    const report = await assessRecovery(store, { ...RECOVERY_INPUT, slotId: 'nope@x', dryRun: true });
    expect(report.eligible).toBe(false);
    expect(report.refusal).toBe('slot_not_found');
  });
});

describe('the grant preserves history and does not dispatch', () => {
  it('returns the occurrence to pending with attempt_count untouched', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);

    const { report, storeResult, events } = await recoverOccurrence(store, RECOVERY_INPUT);

    expect(storeResult).toBe('requeued');
    expect(report.eligible).toBe(true);

    const slot = store.slots.get(SLOT)!;
    expect(slot.status).toBe('pending');
    // The first three attempts are still on the record: nothing was renumbered.
    expect(slot.attemptCount).toBe(3);
    expect(slot.recoveryCount).toBe(1);
    expect(slot.recoveryGeneration).toBe(1);
    expect(slot.recoveryReason).toContain('legacy Fly watchdog');
    // No synthetic occurrence and no rewritten identity.
    expect(slot.id).toBe(SLOT);
    expect(slot.occurrenceAt).toBe(OCCURRENCE_AT);
    // A fresh business window, measured from the operator action.
    expect(slot.dispatchDeadline).toBe(NOW + 6 * 60 * 60 * 1000);

    // The grant itself dispatches nothing.
    expect(store.executions.size).toBe(3);

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.event).toBe('occurrence_requeued_by_operator');
    expect(event.slotId).toBe(SLOT);
    expect(event.attempt).toBe(4);
    const detail = JSON.parse(event.detail!);
    expect(detail.previousStatus).toBe('failed');
    expect(detail.previousAttemptCount).toBe(3);
    expect(detail.nextAttempt).toBe(4);
    expect(detail.reason).toContain('legacy Fly watchdog');
    expect(detail.actor).toBe('operator');
    expect(detail.automaticMaxAttempts).toBe(3);
  });

  it('keeps the three failed attempts and their audits', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    const before = [...store.executions.values()].map((execution) => ({
      attempt: execution.attempt,
      status: execution.status,
      error: execution.error,
    }));
    expect(before).toHaveLength(3);
    expect(before.every((attempt) => attempt.status === 'failed')).toBe(true);

    await recoverOccurrence(store, RECOVERY_INPUT);

    const after = [...store.executions.values()].map((execution) => execution.attempt);
    expect(after.sort()).toEqual([1, 2, 3]);
    for (const execution of store.executions.values()) {
      expect(execution.status).toBe('failed');
    }
  });

  it('audits a refusal without granting anything', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await store.setSlotStatus(SLOT, 'success', NOW);

    const { report, storeResult, events } = await recoverOccurrence(store, RECOVERY_INPUT);
    expect(storeResult).toBeNull();
    expect(events).toHaveLength(0);
    expect(store.slots.get(SLOT)!.recoveryCount).toBe(0);

    const refusal = refusalEvent(report, NOW);
    expect(refusal!.event).toBe('occurrence_requeue_refused');
    expect(JSON.parse(refusal!.detail!).refusal).toBe('status_not_recoverable');
  });

  it('records nothing at all for a dry run', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);
    await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true });

    expect(store.slots.get(SLOT)!.recoveryCount).toBe(0);
    expect(store.events).toHaveLength(0);
    expect(refusalEvent({ ...(await assessRecovery(store, { ...RECOVERY_INPUT, dryRun: true })) }, NOW)).toBeNull();
  });
});

describe('idempotency', () => {
  it('grants exactly one recovery for a sequential duplicate request', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);

    const first = await recoverOccurrence(store, RECOVERY_INPUT);
    const second = await recoverOccurrence(store, RECOVERY_INPUT);

    expect(first.storeResult).toBe('requeued');
    // The second request sees `pending`, which is not a recoverable terminal state.
    expect(second.storeResult).toBeNull();
    expect(second.report.refusal).toBe('status_not_recoverable');
    expect(store.slots.get(SLOT)!.recoveryCount).toBe(1);
  });

  it('gives concurrent requests exactly one winner', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);

    const [a, b] = await Promise.all([
      recoverOccurrence(store, RECOVERY_INPUT),
      recoverOccurrence(store, RECOVERY_INPUT),
    ]);

    const granted = [a, b].filter((result) => result.storeResult === 'requeued');
    const refused = [a, b].filter((result) => result.storeResult !== 'requeued');
    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.report.refusal).toBe('grant_conflict');
    // One recovery, not attempt 4 and 5.
    expect(store.slots.get(SLOT)!.recoveryCount).toBe(1);
    expect([...store.executions.values()]).toHaveLength(3);
  });

  it('survives a concurrent grant by bumping the generation under the loser', async () => {
    const store = new MemoryControlStore();
    await exhausted(store);

    // Both read the same pre-state, then both try to grant.
    const observed = (await store.getOccurrence(SLOT))!;
    const first = await store.grantRecoveryAttempt({
      slotId: SLOT,
      reason: 'first',
      actor: 'operator-a',
      nowMs: NOW,
      dispatchDeadline: NOW + 1000,
      expectedStatus: observed.status,
      expectedGeneration: observed.recoveryGeneration,
    });
    const second = await store.grantRecoveryAttempt({
      slotId: SLOT,
      reason: 'second',
      actor: 'operator-b',
      nowMs: NOW,
      dispatchDeadline: NOW + 1000,
      expectedStatus: observed.status,
      expectedGeneration: observed.recoveryGeneration,
    });

    expect(first).toBe('requeued');
    expect(second).toBe('conflict');
    expect(store.slots.get(SLOT)!.recoveryCount).toBe(1);
  });
});

describe('the recovered occurrence goes back through normal dispatch', () => {
  async function recovered() {
    const store = new MemoryControlStore();
    await exhausted(store);
    await recoverOccurrence(store, RECOVERY_INPUT);
    const provider = new FakeProvider();
    return { store, provider };
  }

  it('is dispatched by reconciliation as attempt 4', async () => {
    const { store, provider } = await recovered();

    const summary = await reconcileAll(
      { store, provider, schedules: SCHEDULES_UNDER_TEST, ...DEPLOY } as never,
      NOW + 60_000
    );

    expect(summary.dispatched).toBe(1);
    expect(provider.dispatches).toHaveLength(1);
    expect(provider.dispatches[0]!.attempt).toBe(4);
    expect(provider.dispatches[0]!.credentialKey).toBe(PIXIV_CREDENTIAL);
    expect(provider.dispatches[0]!.slotId).toBe(SLOT);

    const slot = store.slots.get(SLOT)!;
    expect(slot.attemptCount).toBe(4);
    expect(slot.status).toBe('dispatched');
  });

  it('does not become dispatchable a third time from one grant', async () => {
    const { store, provider } = await recovered();

    await reconcileAll({ store, provider, schedules: SCHEDULES_UNDER_TEST, ...DEPLOY } as never, NOW + 60_000);
    // Finish attempt 4 as a failure, with no grant outstanding.
    const execution = [...store.executions.values()].find((row) => row.attempt === 4)!;
    await store.markExecutionTerminal({ executionId: execution.id, status: 'failed', nowMs: NOW, error: 'again' });
    await store.setSlotStatus(SLOT, 'failed', NOW);

    await reconcileAll(
      { store, provider, schedules: SCHEDULES_UNDER_TEST, ...DEPLOY } as never,
      NOW + 120_000
    );
    // One grant bought exactly one attempt: the recovered slot is not due again.
    expect(provider.dispatches.filter((dispatch) => dispatch.slotId === SLOT)).toHaveLength(1);
    expect(store.slots.get(SLOT)!.status).toBe('failed');
    expect(store.slots.get(SLOT)!.attemptCount).toBe(4);
  });

  it('is held, not dispatched in parallel, while another occurrence holds pixiv-main', async () => {
    const { store, provider } = await recovered();

    // bot2's occurrence is mid-flight on the same credential.
    await store.insertOccurrenceIfAbsent(
      occurrence('bot2-daily@2026-09-11T1010', 'bot2-daily', 'bot2'),
      OCCURRENCE_AT
    );
    await store.openExecution({
      id: 'bot2-busy',
      slotId: 'bot2-daily@2026-09-11T1010',
      attempt: 1,
      provider: 'fake',
      nowMs: NOW,
    });
    await store.setSlotStatus('bot2-daily@2026-09-11T1010', 'dispatched', NOW);

    const summary = await reconcileAll(
      { store, provider, schedules: SCHEDULES_UNDER_TEST, ...DEPLOY } as never,
      NOW + 60_000
    );

    expect(summary.dispatched).toBe(0);
    expect(summary.held).toBeGreaterThanOrEqual(1);
    expect(store.slots.get(SLOT)!.status).toBe('pending');
    expect(store.events.some((event) => event.event === 'dispatch_held')).toBe(true);
  });

  it('lets the recovery attempt update slot items, and a late attempt-3 report cannot', async () => {
    const { store, provider } = await recovered();
    await reconcileAll({ store, provider, schedules: SCHEDULES_UNDER_TEST, ...DEPLOY } as never, NOW + 60_000);

    // Attempt 4 succeeds for its target.
    await store.upsertSlotItem({
      slotId: SLOT,
      botId: 'bot1',
      item: { targetId: 'bot1-illust', status: 'submitted', attempt: 4, workId: '12345' },
      nowMs: NOW + 120_000,
    });
    const item = (await store.listSlotItems(SLOT))[0]!;
    expect(item.status).toBe('submitted');
    expect(item.attemptCount).toBe(4);

    // A late report from attempt 3 must not clobber it.
    const late = await store.upsertSlotItem({
      slotId: SLOT,
      botId: 'bot1',
      item: { targetId: 'bot1-illust', status: 'failed', attempt: 3, workId: '12345' },
      nowMs: NOW + 180_000,
    });
    expect(late).toBe('skipped-terminal');
    expect((await store.listSlotItems(SLOT))[0]!.status).toBe('submitted');
    expect((await store.listSlotItems(SLOT))[0]!.attemptCount).toBe(4);
  });
});
