import { describe, expect, it } from 'vitest';

import {
  applyExecutionResult,
  claimExecution,
  executionIdFor,
  reconcileExecution,
  slotRollup,
  startAttempt,
  statusFromConclusion,
  DISPATCH_CLAIM_GRACE_MS,
} from '../src/execution';
import { reconcileAll } from '../src/reconciliation';
import { handleControl } from '../src/routes/control';
import { SCHEDULES } from '../src/schedules';
import { FakeProvider, MemoryControlStore } from './memory-store';

const CALLBACK = 'https://control.example/control';
const schedule = SCHEDULES.find((s) => s.id === 'bot1-daily')!;

/** Seed one due occurrence (18:00 Shanghai == 10:00Z). */
async function seedDueSlot(store: MemoryControlStore, nowMs: number, slotId = 'bot1-daily@2026-09-11T1800') {
  const occurrence = {
    slotId,
    scheduleId: schedule.id,
    botId: schedule.botId,
    occurrenceAt: Date.parse('2026-09-11T10:00:00Z'),
    occurrenceDate: '2026-09-11',
    occurrenceLabel: '18:00',
    timezone: schedule.timezone,
    dispatchDeadline: Date.parse('2026-09-11T10:00:00Z') + schedule.dispatchDeadlineHours * 3600_000,
  };
  await store.insertOccurrenceIfAbsent(occurrence, nowMs);
  return (await store.getOccurrence(occurrence.slotId))!;
}

const NOW = Date.parse('2026-09-11T10:05:00Z');

describe('dispatch is at-most-once per attempt', () => {
  it('opens one attempt, marks the slot dispatched and starts a runner', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);

    const result = await startAttempt(
      store,
      provider,
      {
        slot,
        scheduleId: schedule.id,
        botId: schedule.botId,
        attempt: 1,
        targets: ['bot1-illust-botefuku'],
        callbackUrl: CALLBACK, pixivflowRef: 'test-ref',
        mode: 'shadow',
      },
      NOW
    );

    expect(result.dispatched).toBe(true);
    expect(result.executionId).toBe('bot1-daily@2026-09-11T1800#1');
    expect(provider.dispatched).toEqual([{ slotId: slot.id, attempt: 1 }]);
    const updated = (await store.getOccurrence(slot.id))!;
    expect(updated.status).toBe('dispatched');
    expect(updated.attemptCount).toBe(1);
    expect(updated.currentExecutionId).toBe(result.executionId);
  });

  it('refuses to open the same attempt twice (duplicate sweep / concurrent tick)', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const input = {
      slot,
      scheduleId: schedule.id,
      botId: schedule.botId,
      attempt: 1,
      targets: ['bot1-illust-botefuku'],
      callbackUrl: CALLBACK, pixivflowRef: 'test-ref',
      mode: 'shadow' as const,
    };

    await startAttempt(store, provider, input, NOW);
    const second = await startAttempt(store, provider, input, NOW + 1000);

    expect(second.dispatched).toBe(false);
    expect(second.detail).toBe('attempt already open');
    // The provider was called exactly once: no second runner for the same attempt.
    expect(provider.dispatched).toHaveLength(1);
    expect(store.createdExecutionCount).toBe(1);
  });

  it('records a THROWN dispatch as a failed attempt instead of leaving it dispatching', async () => {
    // A provider that throws (network failure, runtime bug such as a detached
    // fetch) must not silently consume one of the occurrence's attempts while the
    // execution sits in `dispatching` until the unclaimed-run grace expires.
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    provider.throwOnDispatch = 'Illegal invocation: function called with incorrect `this` reference';
    const slot = await seedDueSlot(store, NOW);

    const result = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );

    expect(result.dispatched).toBe(false);
    const execution = (await store.getExecution(result.executionId))!;
    expect(execution.status).toBe('failed');
    expect(execution.errorClass).toBe('provider_error');
    expect(execution.error).toContain('dispatch threw');
    expect((await store.getOccurrence(slot.id))!.status).toBe('pending');
    expect(store.eventsNamed('dispatch_failed')).toHaveLength(1);
  });

  it('returns the slot to pending when the provider refuses the dispatch', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    provider.acceptDispatch = false;
    provider.dispatchError = 'github dispatch failed: 403';
    const slot = await seedDueSlot(store, NOW);

    const result = await startAttempt(
      store,
      provider,
      {
        slot,
        scheduleId: schedule.id,
        botId: schedule.botId,
        attempt: 1,
        targets: [],
        callbackUrl: CALLBACK, pixivflowRef: 'test-ref',
        mode: 'shadow',
      },
      NOW
    );

    expect(result.dispatched).toBe(false);
    expect((await store.getExecution(result.executionId))!.status).toBe('failed');
    expect((await store.getOccurrence(slot.id))!.status).toBe('pending');
    expect(store.eventsNamed('dispatch_failed')).toHaveLength(1);
  });
});

describe('results are recorded once and rolled up honestly', () => {
  it('claim marks the execution and slot running', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );

    await claimExecution(store, { executionId, providerRunId: 'run-77' }, NOW + 500);

    expect((await store.getExecution(executionId))!.status).toBe('running');
    expect((await store.getOccurrence(slot.id))!.status).toBe('running');
    expect(store.eventsNamed('github_run_started')).toHaveLength(1);
  });

  it('a replayed result callback does not roll the slot up twice', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );

    const first = await applyExecutionResult(
      store,
      { executionId, status: 'success', maxAttempts: 3, result: '{"status":"success"}' },
      NOW + 1000
    );
    const replay = await applyExecutionResult(
      store,
      { executionId, status: 'failed', maxAttempts: 3, error: 'late duplicate' },
      NOW + 2000
    );

    expect(first?.applied).toBe(true);
    expect(first?.slotStatus).toBe('success');
    expect(replay?.applied).toBe(false);
    // The late "failed" callback must not overwrite the successful occurrence.
    expect((await store.getOccurrence(slot.id))!.status).toBe('success');
    expect(store.eventsNamed('slot_terminal')).toHaveLength(1);
  });

  it('retries a failed attempt while attempts remain, then fails the occurrence', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);

    const attempt1 = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );
    await applyExecutionResult(
      store,
      { executionId: attempt1.executionId, status: 'failed', maxAttempts: 3, error: 'pixiv 429' },
      NOW + 1000
    );
    expect((await store.getOccurrence(slot.id))!.status).toBe('pending');
    expect(store.eventsNamed('retry_scheduled')).toHaveLength(1);

    // The next sweep opens attempt 2 for the SAME slot.
    const afterRetry = (await store.getOccurrence(slot.id))!;
    const attempt2 = await startAttempt(
      store,
      provider,
      { slot: afterRetry, scheduleId: schedule.id, botId: schedule.botId, attempt: afterRetry.attemptCount + 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW + 2000
    );
    expect(attempt2.executionId).toBe(executionIdFor(slot.id, 2));

    await applyExecutionResult(
      store,
      { executionId: attempt2.executionId, status: 'failed', maxAttempts: 3, error: 'pixiv 429' },
      NOW + 3000
    );
    const retried = (await store.getOccurrence(slot.id))!;
    await startAttempt(
      store,
      provider,
      { slot: retried, scheduleId: schedule.id, botId: schedule.botId, attempt: retried.attemptCount + 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW + 4000
    );
    const last = await applyExecutionResult(
      store,
      { executionId: executionIdFor(slot.id, 3), status: 'failed', maxAttempts: 3, error: 'pixiv 429' },
      NOW + 5000
    );

    // Attempt 3 of 3: the occurrence is finally terminal.
    expect(last?.slotStatus).toBe('failed');
    expect((await store.getOccurrence(slot.id))!.status).toBe('failed');
    expect(store.eventsNamed('slot_terminal')).toHaveLength(1);
  });

  it('treats an unconfirmed delivery as terminal, never as retryable', async () => {
    const outcome = slotRollup('uncertain', 1, 3);
    expect(outcome).toBe('uncertain');
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );
    await applyExecutionResult(
      store,
      { executionId, status: 'uncertain', maxAttempts: 3, error: 'telegram ack lost', errorClass: 'uncertain_delivery' },
      NOW + 1000
    );
    expect((await store.getOccurrence(slot.id))!.status).toBe('uncertain');
  });
});

describe('losing a callback is survivable (provider state is authoritative)', () => {
  it('closes the execution with GitHub’s verdict when the runner never reported', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );
    // The runner claimed the run, then died before posting its result.
    await claimExecution(store, { executionId, providerRunId: '1' }, NOW + 500);
    provider.concludeLastRun('completed', 'success');

    const execution = (await store.getExecution(executionId))!;
    const outcome = await reconcileExecution(store, execution, provider, 3, NOW + 60_000);

    expect(outcome).toBe('reconciled');
    expect((await store.getExecution(executionId))!.status).toBe('success');
    expect((await store.getOccurrence(slot.id))!.status).toBe('success');
  });

  it('adopts the run the provider really started when the dispatch response was lost', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );
    // GitHub accepted the dispatch but our HTTP call never returned a run id.
    const execution = (await store.getExecution(executionId))!;
    expect(execution.providerRunId).toBeNull();

    const outcome = await reconcileExecution(
      store,
      execution,
      provider,
      3,
      NOW + DISPATCH_CLAIM_GRACE_MS + 1000
    );

    expect(outcome).toBe('reconciled');
    expect((await store.getExecution(executionId))!.providerRunId).toBe('1');
    // Crucially: the occurrence is NOT re-dispatched alongside the adopted run.
    expect((await store.getOccurrence(slot.id))!.status).toBe('dispatched');
  });

  it('fails the attempt and re-queues the occurrence when no run was ever created', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );
    provider.recent = []; // nothing was actually started

    const outcome = await reconcileExecution(
      store,
      (await store.getExecution(executionId))!,
      provider,
      3,
      NOW + DISPATCH_CLAIM_GRACE_MS + 1000
    );

    expect(outcome).toBe('abandoned');
    expect((await store.getExecution(executionId))!.errorClass).toBe('infrastructure_error');
    expect((await store.getOccurrence(slot.id))!.status).toBe('pending');
  });

  it('leaves a fresh unclaimed dispatch alone inside the grace window', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );
    const outcome = await reconcileExecution(
      store,
      (await store.getExecution(executionId))!,
      provider,
      3,
      NOW + 1000
    );
    expect(outcome).toBe('unchanged');
  });

  it('maps every terminal conclusion to an explicit status', () => {
    expect(statusFromConclusion('success')).toEqual({ status: 'success', errorClass: 'none' });
    expect(statusFromConclusion('failure').status).toBe('failed');
    expect(statusFromConclusion('timed_out').status).toBe('timeout');
    expect(statusFromConclusion('cancelled').status).toBe('cancelled');
    expect(statusFromConclusion('startup_failure').errorClass).toBe('provider_error');
    expect(statusFromConclusion(null).status).toBe('failed');
  });

  it('a cancelled execution stays terminal; the occurrence is retried as a new attempt', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    provider.nowMs = NOW;
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW
    );
    await claimExecution(store, { executionId, providerRunId: '1' }, NOW + 500);
    provider.concludeLastRun('completed', 'cancelled');
    await reconcileExecution(store, (await store.getExecution(executionId))!, provider, 3, NOW + 1000);

    // The attempt is terminal and immutable...
    expect((await store.getExecution(executionId))!.status).toBe('cancelled');
    // ...while the occurrence is retryable, so the next sweep opens attempt 2
    // instead of resurrecting attempt 1 (no double rollup of the same attempt).
    const slotAfter = (await store.getOccurrence(slot.id))!;
    expect(slotAfter.status).toBe('pending');
    const attempt2 = await startAttempt(
      store,
      provider,
      { slot: slotAfter, scheduleId: schedule.id, botId: schedule.botId, attempt: slotAfter.attemptCount + 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'test-ref', mode: 'shadow' },
      NOW + 2000
    );
    expect(attempt2.executionId).toBe(executionIdFor(slot.id, 2));
  });
});

describe('a full sweep converges without duplicating work', () => {
  it('dispatches a due occurrence once and does nothing on the next sweep', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    // 18:20 Shanghai: all four of the day's occurrences exist by now, so the
    // first sweep creates the complete set and nothing new can appear later.
    const now = Date.parse('2026-09-11T10:20:00Z');
    provider.nowMs = now;

    const first = await reconcileAll(
      { store, provider, schedules: SCHEDULES, mode: 'shadow', callbackUrl: CALLBACK, pixivflowRef: 'test-ref' },
      now
    );
    expect(first.created).toBeGreaterThan(0);
    expect(first.dispatched).toBeGreaterThan(0);
    expect(provider.dispatched).toHaveLength(first.dispatched);

    const second = await reconcileAll(
      { store, provider, schedules: SCHEDULES, mode: 'shadow', callbackUrl: CALLBACK, pixivflowRef: 'test-ref' },
      now + 10 * 60_000
    );
    expect(second.created).toBe(0);
    // Nothing was re-dispatched: the first attempts are unclaimed-but-fresh, so
    // the occurrences are not handed to a second runner.
    expect(second.dispatched).toBe(0);
    expect(provider.dispatched).toHaveLength(first.dispatched);
  });

  it('keeps bot1 and bot2 occurrences on separate schedules', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await reconcileAll(
      { store, provider, schedules: SCHEDULES, mode: 'shadow', callbackUrl: CALLBACK, pixivflowRef: 'test-ref' },
      Date.parse('2026-09-11T10:20:00Z')
    );
    const bot1 = [...store.slots.values()].filter((slot) => slot.botId === 'bot1');
    const bot2 = [...store.slots.values()].filter((slot) => slot.botId === 'bot2');
    expect(bot1.length).toBeGreaterThan(0);
    expect(bot2.length).toBeGreaterThan(0);
    expect(bot1.every((slot) => slot.scheduleId === 'bot1-daily')).toBe(true);
    expect(bot2.every((slot) => slot.scheduleId === 'bot2-daily')).toBe(true);
  });
});

describe('convergence under concurrency', () => {
  it('two concurrent sweeps dispatch exactly one attempt and record no error', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const now = Date.parse('2026-09-11T10:20:00Z');
    provider.nowMs = now;
    const deps = {
      store,
      provider,
      schedules: SCHEDULES,
      mode: 'shadow' as const,
      callbackUrl: CALLBACK,
      pixivflowRef: 'test-ref',
    };

    const [a, b] = await Promise.all([reconcileAll(deps, now), reconcileAll(deps, now)]);

    // The unique (slot_id, attempt) key elects one dispatcher; the other sweep
    // converges instead of starting a second runner.
    expect(provider.dispatched.length).toBe(a.dispatched + b.dispatched);
    expect(a.dispatched + b.dispatched).toBeGreaterThan(0);
    expect(store.eventsNamed('dispatch_started')).toHaveLength(provider.dispatched.length);
    // Convergence is not an error worth alerting on.
    expect(a.errors.length + b.errors.length).toBe(0);
    for (const slot of store.slots.values()) {
      const executions = [...store.executions.values()].filter((row) => row.slotId === slot.id);
      expect(executions.length).toBeLessThanOrEqual(1);
    }
  });
});

describe('durable duplicate history for disposable runners', () => {
  const secret = 'control-secret';
  const authedPost = (path: string, body: unknown) =>
    new Request(`https://control.example${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify(body),
    });

  it('records works reported as submitted, idempotently', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    const slot = await seedDueSlot(store, NOW);
    const { executionId } = await startAttempt(
      store,
      provider,
      { slot, scheduleId: schedule.id, botId: schedule.botId, attempt: 1, targets: [], callbackUrl: CALLBACK, pixivflowRef: 'r', mode: 'shadow' },
      NOW
    );

    const body = {
      items: [
        { target_id: 'bot1-illust-botefuku', status: 'submitted', work_type: 'illustration', work_id: '29088506' },
        { target_id: 'bot1-novel-botefuku', status: 'no_candidate', work_type: 'novel' },
      ],
    };
    const first = await handleControl(authedPost(`/control/executions/${encodeURIComponent(executionId)}/items`, body), store, new URL(`https://c/control/executions/${encodeURIComponent(executionId)}/items`), secret);
    expect(await first!.json()).toMatchObject({ processedWorksRecorded: 1 });

    // A replayed item report must not create a second history entry.
    const replay = await handleControl(authedPost(`/control/executions/${encodeURIComponent(executionId)}/items`, body), store, new URL(`https://c/control/executions/${encodeURIComponent(executionId)}/items`), secret);
    expect(await replay!.json()).toMatchObject({ processedWorksRecorded: 0 });

    const listed = await handleControl(
      new Request('https://control.example/control/processed-works?bot_id=bot1', { headers: { authorization: `Bearer ${secret}` } }),
      store,
      new URL('https://control.example/control/processed-works?bot_id=bot1'),
      secret
    );
    expect(await listed!.json()).toMatchObject({
      ok: true,
      botId: 'bot1',
      count: 1,
      works: { illustration: ['29088506'] },
    });

    // Unknown work ids never enter history just because an item was reported.
    const other = await handleControl(
      new Request('https://control.example/control/processed-works?bot_id=bot2', { headers: { authorization: `Bearer ${secret}` } }),
      store,
      new URL('https://control.example/control/processed-works?bot_id=bot2'),
      secret
    );
    expect(await other!.json()).toMatchObject({ count: 0, works: {} });
  });
});
