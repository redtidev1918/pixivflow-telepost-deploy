/**
 * Credential execution admission.
 *
 * One credential is one externally rate-limited resource. `pixiv-main` declares
 * `maxConcurrentExecutions: 1`, so any two occurrences that consume it must run
 * serially — across slots, because bot1 10:00 and bot2 10:10 are different slots
 * sharing one account.
 *
 * The authority is D1 and it is DERIVED: an occurrence holds the credential while it
 * has an execution in `dispatching`/`dispatched`/`running`, and the credential is free
 * when that set is empty. There is no second lock row to drift out of sync, no lease to
 * renew, and no fencing token — the execution row *is* the lock.
 *
 * The tests below are the contract: same credential serialises, different credentials
 * run in parallel, every terminal status releases, a lost callback releases through
 * provider reconciliation rather than through the runner, and two reconcilers that
 * both see the credential free must still produce exactly one holder.
 */

import { describe, expect, it } from 'vitest';

import { MemoryControlStore, FakeProvider } from './memory-store';
import { reconcileAll } from '../src/reconciliation';
import type { Occurrence } from '../src/occurrences';

const NOW = Date.parse('2026-09-11T04:40:00Z');
const OCCURRENCE_AT = Date.parse('2026-09-11T02:00:00Z');

const PIXIV = 'pixiv-main';
const ALT = 'pixiv-alt';

const SCHEDULES_UNDER_TEST = [
  {
    id: 'bot1-daily',
    botId: 'bot1',
    times: ['10:00'],
    timezone: 'Asia/Shanghai',
    targets: [{ id: 'bot1-illust', workType: 'illustration' as const }],
    credential: PIXIV,
    dispatchDeadlineHours: 6,
    maxAttempts: 3,
  },
  {
    id: 'bot2-daily',
    botId: 'bot2',
    times: ['10:10'],
    timezone: 'Asia/Shanghai',
    targets: [{ id: 'bot2-illust', workType: 'illustration' as const }],
    credential: PIXIV,
    dispatchDeadlineHours: 6,
    maxAttempts: 3,
  },
  {
    // A different account: unrelated to the Pixiv limit, so it may run alongside.
    id: 'bot3-daily',
    botId: 'bot3',
    times: ['10:20'],
    timezone: 'Asia/Shanghai',
    targets: [{ id: 'bot3-illust', workType: 'illustration' as const }],
    credential: ALT,
    dispatchDeadlineHours: 6,
    maxAttempts: 3,
  },
];

const DEPLOY = { mode: 'live' as const, callbackUrl: 'https://cp.test/control', pixivflowRef: 'master' };

// `reconcileAll` CREATES the occurrences it finds missing for every schedule it is
// given, so a test that passes all three schedules also dispatches the unrelated
// credential. Each test names exactly the schedules it is about.
const PIXIV_ONLY = SCHEDULES_UNDER_TEST.filter((schedule) => schedule.credential === PIXIV);
const WITH_ALT = SCHEDULES_UNDER_TEST;
const BOT1_ONLY = [PIXIV_ONLY[0]!];

function occurrence(slotId: string, scheduleId: string, botId: string, at = OCCURRENCE_AT): Occurrence {
  return {
    slotId,
    scheduleId,
    botId,
    occurrenceAt: at,
    occurrenceDate: '2026-09-11',
    occurrenceLabel: '10:00',
    timezone: 'Asia/Shanghai',
    dispatchDeadline: at + 6 * 60 * 60 * 1000,
  };
}

async function dueSlot(store: MemoryControlStore, slotId: string): Promise<void> {
  const scheduleId = slotId.slice(0, slotId.indexOf('@'));
  const botId = scheduleId.split('-')[0]!;
  const at = Date.parse('2026-09-11T02:00:00Z') + (scheduleId === 'bot2-daily' ? 600_000 : 0);
  await store.insertOccurrenceIfAbsent(occurrence(slotId, scheduleId, botId, at), at);
}

async function sweep(
  store: MemoryControlStore,
  provider: FakeProvider,
  nowMs = NOW + 60_000,
  schedules = PIXIV_ONLY
) {
  return reconcileAll({ store, provider, schedules, ...DEPLOY } as never, nowMs);
}

/**
 * Open an execution and put the slot in flight, as a real dispatch does.
 *
 * The credential is passed because `startAttempt` always passes it: a holder that
 * did not acquire the credential is not a holder, and a test that omitted it would
 * prove nothing about admission.
 */
async function hold(
  store: MemoryControlStore,
  slotId: string,
  attempt = 1,
  credentialKey = PIXIV
): Promise<string> {
  const executionId = `${slotId}#${attempt}`;
  await store.openExecution({
    id: executionId,
    slotId,
    attempt,
    provider: 'fake',
    nowMs: NOW,
    credentialKey,
  });
  await store.setSlotStatus(slotId, 'dispatched', NOW);
  await store.markExecutionRunning(executionId, `run-${attempt}`, NOW);
  return executionId;
}

describe('same credential serialises across slots', () => {
  it('holds bot2 while bot1 holds pixiv-main, with no GitHub dispatch', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await dueSlot(store, 'bot2-daily@2026-09-11T1010');
    await hold(store, 'bot1-daily@2026-09-11T1000');

    const summary = await sweep(store, provider);

    expect(summary.dispatched).toBe(0);
    expect(provider.dispatches).toHaveLength(0);
    expect(store.slots.get('bot2-daily@2026-09-11T1010')!.status).toBe('pending');
    const held = store.events.filter((event) => event.event === 'dispatch_held');
    expect(held).toHaveLength(1);
    expect(held[0]!.detail).toContain(PIXIV);
  });

  it('keeps exactly one active holder across the whole sweep', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    for (const slotId of ['bot1-daily@2026-09-11T1000', 'bot2-daily@2026-09-11T1010']) {
      await dueSlot(store, slotId);
    }

    await sweep(store, provider);

    expect(await store.countOpenExecutionsForSlot('bot1-daily@2026-09-11T1000')).toBe(1);
    expect(await store.countOpenExecutionsForSlot('bot2-daily@2026-09-11T1010')).toBe(0);
    expect(provider.dispatches).toHaveLength(1);
  });

  it('releases the credential when the holder reaches a terminal status', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await dueSlot(store, 'bot2-daily@2026-09-11T1010');
    const executionId = await hold(store, 'bot1-daily@2026-09-11T1000');

    expect((await sweep(store, provider)).dispatched).toBe(0);

    await store.markExecutionTerminal({ executionId, status: 'failed', nowMs: NOW + 120_000, error: 'x' });
    await store.setSlotStatus('bot1-daily@2026-09-11T1000', 'failed', NOW + 120_000);

    const next = await sweep(store, provider, NOW + 180_000);
    expect(next.dispatched).toBe(1);
    expect(provider.dispatches[0]!.slotId).toBe('bot2-daily@2026-09-11T1010');
  });

  it.each(['success', 'partial', 'failed', 'cancelled', 'timeout'] as const)(
    'releases on %s',
    async (status) => {
      const store = new MemoryControlStore();
      const provider = new FakeProvider();
      await dueSlot(store, 'bot1-daily@2026-09-11T1000');
      await dueSlot(store, 'bot2-daily@2026-09-11T1010');
      const executionId = await hold(store, 'bot1-daily@2026-09-11T1000');

      await store.markExecutionTerminal({ executionId, status, nowMs: NOW + 120_000 });
      // `timeout` is an execution status; the slot terminal for it is `failed`.
      const slotStatus = status === 'success' || status === 'partial' ? 'success' : 'failed';
      await store.setSlotStatus('bot1-daily@2026-09-11T1000', slotStatus, NOW + 120_000);

      const next = await sweep(store, provider, NOW + 180_000);
      expect(next.dispatched).toBe(1);
      expect(provider.dispatches[0]!.slotId).toBe('bot2-daily@2026-09-11T1010');
    }
  );
});

describe('different credentials do not block each other', () => {
  it('runs pixiv-alt alongside pixiv-main', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await dueSlot(store, 'bot3-daily@2026-09-11T1000');
    await hold(store, 'bot1-daily@2026-09-11T1000');

    const summary = await sweep(store, provider, NOW + 60_000, WITH_ALT);

    expect(summary.dispatched).toBe(1);
    expect(provider.dispatches.map((dispatch) => dispatch.slotId)).toEqual([
      'bot3-daily@2026-09-11T1000',
    ]);
    expect(provider.dispatches[0]!.credentialKey).toBe(ALT);
  });
});

describe('the credential is released by state, never by the runner', () => {
  it('releases when provider reconciliation discovers a finished run after a lost callback', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await dueSlot(store, 'bot2-daily@2026-09-11T1010');
    // The real order: open -> provider accepts and the run id is attached (while
    // still `dispatching`) -> the runner claims it -> the runner dies without
    // reporting. Nothing about the release may depend on that last step happening.
    const executionId = 'bot1-daily@2026-09-11T1000#1';
    await store.openExecution({ id: executionId, slotId: 'bot1-daily@2026-09-11T1000', attempt: 1, provider: 'fake', nowMs: NOW });
    await store.setSlotStatus('bot1-daily@2026-09-11T1000', 'dispatched', NOW);
    await store.attachProviderRun(executionId, 'run-lost', NOW);
    await store.markExecutionRunning(executionId, 'run-lost', NOW);

    // The runner died without reporting. The provider knows how the run ended, and
    // that is what must free the credential -- no callback, no runner cooperation.
    // The provider is the authority on how a run ended: `getRun` is what a known
    // provider_run_id goes through, so the run must exist there too.
    const lostRun = { runId: 'run-lost', state: 'completed' as const, conclusion: 'failure' as const, createdAt: NOW };
    provider.runs.set('run-lost', lostRun);
    provider.recent.push(lostRun);

    const summary = await sweep(store, provider, NOW + 120_000);

    const execution = await store.getExecution(executionId);
    expect(execution!.status).not.toBe('running');
    expect(summary.reconciled).toBeGreaterThanOrEqual(1);
    expect(summary.dispatched).toBe(1);
    expect(provider.dispatches[0]!.slotId).toBe('bot2-daily@2026-09-11T1010');
  });

  it('does not dispatch before retry_not_before, even with a free credential', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await store.setRetryNotBefore('bot1-daily@2026-09-11T1000', NOW + 600_000);

    const early = await sweep(store, provider, NOW + 60_000, BOT1_ONLY);
    expect(early.dispatched).toBe(0);

    const late = await sweep(store, provider, NOW + 660_000, BOT1_ONLY);
    expect(late.dispatched).toBe(1);
    expect(provider.dispatches[0]!.slotId).toBe('bot1-daily@2026-09-11T1000');
  });
});

describe('concurrency', () => {
  it('lets only one reconciler acquire when two see the credential free', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await dueSlot(store, 'bot2-daily@2026-09-11T1010');

    // Two sweeps racing on the same free credential. This is the race that a
    // read-then-act admission loses, and it is the one that lets two runners touch
    // one Pixiv account from a single control plane.
    const [first, second] = await Promise.all([sweep(store, provider), sweep(store, provider)]);

    expect(provider.dispatches).toHaveLength(1);
    expect(first.dispatched + second.dispatched).toBe(1);
    const open = await store.listOpenExecutions(10);
    expect(open).toHaveLength(1);
  });

  it('turns a lost credential race into `held`, never into an error', async () => {
    const store = new MemoryControlStore();
    const provider = new FakeProvider();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await dueSlot(store, 'bot2-daily@2026-09-11T1010');
    await hold(store, 'bot1-daily@2026-09-11T1000');

    // Force the exact window a concurrent reconciler creates: the holder exists, but
    // THIS sweep read the credential as free. The pre-check therefore lets bot2
    // through, and only the atomic acquire can stop it.
    const realListOpenExecutions = store.listOpenExecutions.bind(store);
    store.listOpenExecutions = async () => [];

    const summary = await sweep(store, provider, NOW + 60_000);
    store.listOpenExecutions = realListOpenExecutions;

    expect(provider.dispatches).toHaveLength(0);
    expect(summary.dispatched).toBe(0);
    expect(summary.held).toBe(1);
    // A converging outcome must not be reported as a failure.
    expect(summary.errors).toEqual([]);
    const held = store.events.filter((event) => event.event === 'dispatch_held');
    expect(held).toHaveLength(1);
    expect(JSON.parse(held[0]!.detail!)).toEqual({ reason: 'credential_busy', credential: PIXIV });
    expect(store.slots.get('bot2-daily@2026-09-11T1010')!.status).toBe('pending');
    expect(await store.listOpenExecutions(10)).toHaveLength(1);
  });

  it('never opens a second execution for the same attempt', async () => {
    const store = new MemoryControlStore();
    await dueSlot(store, 'bot1-daily@2026-09-11T1000');
    await hold(store, 'bot1-daily@2026-09-11T1000');

    // Same attempt: refused by (slot_id, attempt) uniqueness, not by admission.
    expect(
      await store.openExecution({
        id: 'bot1-daily@2026-09-11T1000#1',
        slotId: 'bot1-daily@2026-09-11T1000',
        attempt: 1,
        provider: 'fake',
        nowMs: NOW,
        credentialKey: PIXIV,
      })
    ).toBe('exists');

    // Different attempt, same credential, holder still open: refused by admission.
    expect(
      await store.openExecution({
        id: 'bot1-daily@2026-09-11T1000#2',
        slotId: 'bot1-daily@2026-09-11T1000',
        attempt: 2,
        provider: 'fake',
        nowMs: NOW,
        credentialKey: PIXIV,
      })
    ).toBe('credential-busy');
  });
});
