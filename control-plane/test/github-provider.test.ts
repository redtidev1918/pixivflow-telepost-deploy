import { describe, expect, it } from 'vitest';

import { GitHubActionsExecutionProvider } from '../src/github-provider';
import type { DispatchRequest } from '../src/provider';

const TOKEN = 'ghp_supersecrettokenvalue0000000000';

const request: DispatchRequest = {
  slotId: 'bot1-daily@2026-09-11T1800',
  scheduleId: 'bot1-daily',
  botId: 'bot1',
  occurrenceAt: Date.parse('2026-09-11T10:00:00Z'),
  attempt: 1,
  targets: ['bot1-illust-botefuku', 'bot1-novel-botefuku'],
  callbackUrl: 'https://control.example/control',
  mode: 'shadow',
  pixivflowRef: 'v9.9.9', credentialKey: 'pixiv-main',
};

function provider(fetchImpl: typeof fetch) {
  return new GitHubActionsExecutionProvider(
    { repo: 'owner/repo', workflowFile: 'pixivflow-batch.yml', token: TOKEN, ref: 'main' },
    fetchImpl
  );
}

describe('dispatch', () => {
  it('sends the canonical occurrence and the callback target, never a schedule guess', async () => {
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body));
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await provider(fetchImpl).dispatch(request);

    expect(result.accepted).toBe(true);
    expect(seenUrl).toBe(
      'https://api.github.com/repos/owner/repo/actions/workflows/pixivflow-batch.yml/dispatches'
    );
    expect(seenBody).toMatchObject({
      ref: 'main',
      inputs: {
        slot_id: 'bot1-daily@2026-09-11T1800',
        schedule_id: 'bot1-daily',
        bot_id: 'bot1',
        attempt: '1',
        targets: 'bot1-illust-botefuku,bot1-novel-botefuku',
        callback_url: 'https://control.example/control',
        mode: 'shadow',
        pixivflow_ref: 'v9.9.9',
      },
    });
    expect(seenHeaders.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('reports a refused dispatch instead of pretending a runner started', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"Not Found"}', { status: 404 })) as typeof fetch;
    const result = await provider(fetchImpl).dispatch(request);
    expect(result.accepted).toBe(false);
    expect(result.detail).toContain('404');
  });

  it('never puts the token into an error detail', async () => {
    // The Authorization header carries the credential; nothing the provider
    // reports back to a caller or a log line may repeat it.
    const fetchImpl = (async () =>
      new Response('{"message":"Server Error"}', { status: 500 })) as typeof fetch;
    const result = await provider(fetchImpl).dispatch(request);
    expect(result.accepted).toBe(false);
    expect(result.detail ?? '').not.toContain(TOKEN);
    expect(result.detail ?? '').not.toContain('Bearer');
  });

  it('calls global fetch with the global receiver (Workers reject a detached fetch)', async () => {
    // Regression: storing `fetch` in a property and calling `this.fetch(...)`
    // makes Cloudflare Workers throw "Illegal invocation: function called with
    // incorrect `this` reference" — only observable against the real runtime.
    const original = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = function strictFetch(this: unknown, input: RequestInfo | URL) {
      if (this !== globalThis) {
        throw new Error('Illegal invocation: function called with incorrect `this` reference');
      }
      calls.push(String(input));
      return Promise.resolve(new Response(null, { status: 204 }));
    } as typeof fetch;

    try {
      const result = await provider(undefined as unknown as typeof fetch).dispatch(request);
      expect(result.accepted).toBe(true);
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('provider state is the authority', () => {
  it('maps queued / in_progress / completed with conclusion', async () => {
    const responses: Array<[number, unknown]> = [
      [200, { id: 5, status: 'queued', conclusion: null }],
      [200, { id: 5, status: 'in_progress', conclusion: null }],
      [200, { id: 5, status: 'completed', conclusion: 'timed_out' }],
    ];
    let index = 0;
    const nextResponse = (): unknown => {
      const entry = responses[index++];
      if (!entry) throw new Error('no scripted provider response left');
      return entry[1];
    };
    const fetchImpl = (async () =>
      new Response(JSON.stringify(nextResponse()), { status: 200 })) as typeof fetch;
    const p = provider(fetchImpl);

    expect((await p.getRun('5')).state).toBe('queued');
    expect((await p.getRun('5')).state).toBe('in_progress');
    const done = await p.getRun('5');
    expect(done.state).toBe('completed');
    expect(done.conclusion).toBe('timed_out');
  });

  it('lists only runs created inside the window (used to adopt a lost dispatch)', async () => {
    const since = Date.parse('2026-09-11T10:00:00Z');
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          workflow_runs: [
            { id: 1, status: 'completed', conclusion: 'success', created_at: '2026-09-11T09:59:00Z' },
            { id: 2, status: 'in_progress', conclusion: null, created_at: '2026-09-11T10:00:30Z' },
          ],
        }),
        { status: 200 }
      )) as typeof fetch;

    const runs = await provider(fetchImpl).listRecentRuns(since);
    expect(runs.map((run) => run.runId)).toEqual(['2']);
  });

  it('throws when the provider cannot be queried, instead of guessing a state', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    await expect(provider(fetchImpl).getRun('5')).rejects.toThrow(/getRun failed: 502/);
  });
});
