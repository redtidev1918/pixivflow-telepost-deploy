/**
 * Unit tests for the Fly Machines execution provider.
 *
 * No real network: every call goes through the injected fetch. The assertions
 * pin the exact request contract the machines API expects (metadata identity,
 * auto_destroy, no service registration) because the executor model depends on
 * a machine that cannot outlive its execution.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlyMachinesExecutionProvider, machineNameFor } from '../src/fly-provider';
import type { DispatchRequest } from '../src/provider';

const REQUEST: DispatchRequest = {
  slotId: 'bot2-daily@2026-09-11T1010',
  scheduleId: 'bot2-daily',
  botId: 'bot2',
  occurrenceAt: 1789118220000,
  attempt: 3,
  targets: ['bot2-illust-marunomi', 'bot2-novel-marunomi'],
  callbackUrl: 'https://cp.example/control',
  mode: 'live',
  pixivflowRef: 'master',
  credentialKey: 'pixiv-main',
};

function makeResponse(status: number, body?: unknown): Response {
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

function machine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mach-1',
    state: 'started',
    created_at: '2026-09-11T12:00:00Z',
    config: {
      metadata: { purpose: 'pixivflow-execution', execution_id: 'bot2-daily@2026-09-11T1010#3' },
    },
    ...overrides,
  };
}

let fetchImpl: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchImpl = vi.fn();
});

function provider() {
  return new FlyMachinesExecutionProvider(
    {
      apiToken: 'fly-token',
      appName: 'pixivflow-executor',
      region: 'iad',
      image: 'registry.fly.io/pixivflow-executor:v1',
    },
    fetchImpl as unknown as typeof fetch
  );
}

describe('FlyMachinesExecutionProvider.dispatch', () => {
  it('creates one ephemeral machine carrying the execution identity', async () => {
    // First the idempotency lookup (no machine exists), then the create.
    fetchImpl.mockResolvedValueOnce(makeResponse(200, []));
    fetchImpl.mockResolvedValueOnce(makeResponse(200, { id: 'mach-1' }));

    const result = await provider().dispatch(REQUEST);

    expect(result.accepted).toBe(true);
    expect(result.providerRunId).toBe('mach-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.machines.dev/v1/apps/pixivflow-executor/machines');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fly-token');

    const body = JSON.parse(String(init.body));
    expect(body.region).toBe('iad');
    expect(body.config.image).toBe('registry.fly.io/pixivflow-executor:v1');
    expect(body.config.auto_destroy).toBe(true);
    expect(body.config.restart).toEqual({ policy: 'no' });
    expect(body.config.guest).toEqual({ cpu_kind: 'shared', cpus: 1, memory_mb: 512 });
    expect(body.config.skip_service_registration).toBe(true);

    // Non-secret execution identity only.
    expect(body.config.env).toMatchObject({
      EXECUTION_ID: 'bot2-daily@2026-09-11T1010#3',
      SLOT_ID: REQUEST.slotId,
      ATTEMPT: '3',
      MODE: 'live',
      CREDENTIAL_KEY: 'pixiv-main',
      CALLBACK_URL: 'https://cp.example/control',
      CONTROL_PLANE_URL: 'https://cp.example',
    });
    expect(JSON.stringify(body.config.env)).not.toMatch(/refresh_token|PIXIV_REFRESH/i);
    expect(body.config.metadata).toMatchObject({
      purpose: 'pixivflow-execution',
      execution_id: 'bot2-daily@2026-09-11T1010#3',
      slot_id: REQUEST.slotId,
    });
  });

  it('reports an API failure without pretending the dispatch happened', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(200, []));
    fetchImpl.mockResolvedValueOnce(makeResponse(500, { error: 'no capacity' }));
    const result = await provider().dispatch(REQUEST);
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain('500');
  });

  it('treats a name conflict as "the machine exists; adopt it", not as a failed attempt', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(200, []));
    fetchImpl.mockResolvedValueOnce(makeResponse(409, { error: 'machine name taken' }));
    const result = await provider().dispatch(REQUEST);
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain('already exists');
    expect(result.detail).toContain('adopt');
  });

  it('treats a lost dispatch response as ambiguous, never as "create another"', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(200, []));
    fetchImpl.mockRejectedValueOnce(new Error('the operation was aborted'));
    const result = await provider().dispatch(REQUEST);
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain('reconciler will look for the machine');
  });

  it('adopts an existing machine for the same execution instead of creating a second one', async () => {
    // The create response was lost earlier; the machine exists and carries the
    // execution's metadata. This dispatch must ADOPT it, not duplicate it.
    fetchImpl.mockResolvedValueOnce(
      makeResponse(200, [
        machine({
          id: 'mach-existing',
          name: 'pf-bot2-daily-2026-09-11T1010-abc',
          state: 'started',
        }),
      ])
    );

    const result = await provider().dispatch(REQUEST);

    expect(result.accepted).toBe(true);
    expect(result.providerRunId).toBe('mach-existing');
    // Exactly one call: the idempotency lookup. No create followed.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain('/machines');
    expect(url.endsWith('/machines')).toBe(true);
  });

  it('derives a deterministic, DNS-safe machine name per execution attempt', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(200, []));
    fetchImpl.mockResolvedValueOnce(makeResponse(200, { id: 'mach-1' }));
    await provider().dispatch(REQUEST);
    const [, createInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(String(createInit.body));
    expect(body.name).toMatch(/^pf-[a-zA-Z0-9-]{1,59}$/);
    expect(body.name).toBe(machineNameFor('bot2-daily@2026-09-11T1010#3'));
    // The same execution maps to the same name (idempotency contract).
    expect(machineNameFor('bot2-daily@2026-09-11T1010#3')).toBe(machineNameFor('bot2-daily@2026-09-11T1010#3'));
  });
});

describe('FlyMachinesExecutionProvider.getRun', () => {
  it('maps a started machine to in_progress', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(200, machine()));
    const run = await provider().getRun('mach-1');
    expect(run).toMatchObject({ runId: 'mach-1', state: 'in_progress', conclusion: null });
  });

  it('maps a stopped machine to a terminal run so a lost callback cannot hold the credential', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(200, machine({ state: 'stopped' })));
    const run = await provider().getRun('mach-1');
    expect(run.state).toBe('completed');
  });

  it('maps a destroyed (404) machine to a failed provider run', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(404, { error: 'not found' }));
    const run = await provider().getRun('mach-gone');
    expect(run).toMatchObject({ runId: 'mach-gone', state: 'completed', conclusion: 'failure' });
  });

  it('propagates non-404 API errors to the reconciler', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(500));
    await expect(provider().getRun('mach-1')).rejects.toThrow('500');
  });
});

describe('FlyMachinesExecutionProvider.listRecentRuns', () => {
  it('lists only execution machines, filtered and sorted by creation time', async () => {
    fetchImpl.mockResolvedValueOnce(
      makeResponse(200, [
        machine({ id: 'mach-old', created_at: '2026-09-11T11:00:00Z' }),
        machine({ id: 'mach-new', created_at: '2026-09-11T12:30:00Z' }),
        machine({
          id: 'mach-other',
          created_at: '2026-09-11T12:10:00Z',
          config: { metadata: { purpose: 'something-else' } },
        }),
        { id: 'mach-plain', state: 'started', created_at: '2026-09-11T12:20:00Z' },
      ])
    );
    const since = Date.parse('2026-09-11T12:00:00Z');
    const runs = await provider().listRecentRuns(since);
    expect(runs.map((run) => run.runId)).toEqual(['mach-new']);
  });

  it('propagates API errors to the reconciler', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(502));
    await expect(provider().listRecentRuns(0)).rejects.toThrow('502');
  });
});

describe('FlyMachinesExecutionProvider.cancel', () => {
  it('stops the machine (grace for the result report) instead of destroying it', async () => {
    fetchImpl.mockResolvedValueOnce(makeResponse(200, {}));
    await provider().cancel('mach-1');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.machines.dev/v1/apps/pixivflow-executor/machines/mach-1/stop');
    expect(init.method).toBe('POST');
  });
});
