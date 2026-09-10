import { describe, expect, it } from 'vitest';

import { handleControl } from '../src/routes/control';
import { hashSecret, secretsMatch } from '../src/secrets';
import { MemoryControlStore } from './memory-store';

/**
 * A GitHub runner is destroyed when the job ends. Pixiv may return a NEW refresh
 * token from any refresh — the client already treats that as expected, persisting a
 * rotation to four places — and two successful refreshes returning the same value
 * (observed 2026-09-10) does not prove it can never happen. So a rotation has to
 * land somewhere durable before the run may report success, or it is simply lost
 * along with the runner, taking the account's access with it.
 *
 * These tests pin the storage contract: the control plane keeps it, a rotation is
 * auditable without storing token history, and the value is not readable by a
 * call that was only asking about state.
 */
const SECRET = 'callback-secret';
const NAME = 'pixiv-main';

function request(
  store: MemoryControlStore,
  method: string,
  path: string,
  options: { body?: unknown; secret?: string | null } = {}
): Promise<Response | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearer = options.secret === undefined ? SECRET : options.secret;
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  return handleControl(
    new Request(`https://cp.test${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
    store,
    new URL(`https://cp.test${path}`),
    SECRET
  );
}

describe('runner credential storage', () => {
  it('stores a value and reports what it replaced, never the value', async () => {
    const store = new MemoryControlStore();
    const path = `/control/credentials/${NAME}`;
    const put = async (value: string) =>
      handleControl(
        new Request(`https://cp.test${path}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ value }),
        }),
        store,
        new URL(`https://cp.test${path}`),
        SECRET
      );

    const first = (await (await put('a'.repeat(43)))!.json()) as Record<string, unknown>;
    expect(first).toEqual({ ok: true, name: NAME, stored: true, changed: false, rotations: 0 });

    const second = (await (await put('b'.repeat(43)))!.json()) as Record<string, unknown>;
    expect(second).toEqual({ ok: true, name: NAME, stored: true, changed: true, rotations: 1 });

    // The audit line names the rotation without the value.
    expect(store.events.filter((event) => event.event === 'runner_credential_rotated')).toHaveLength(1);

    const meta = (await (await request(store, 'GET', path))!.json()) as Record<string, unknown>;
    expect(meta.stored).toBe(true);
    expect(meta.rotations).toBe(1);
    expect(meta.previousHash).toBe(await hashSecret('a'.repeat(43)));
    // Metadata must not carry the secret.
    expect(JSON.stringify(meta)).not.toContain('b'.repeat(43));
  });

  it('does not count writing the same value again as a rotation', async () => {
    const store = new MemoryControlStore();
    const value = 'c'.repeat(43);
    await store.putRunnerCredential({ name: NAME, value, nowMs: 1 });
    const again = await store.putRunnerCredential({ name: NAME, value, nowMs: 2 });

    expect(again).toEqual({ stored: true, changed: false, rotations: 0 });
  });

  it('refuses an empty or placeholder value over a live credential', async () => {
    const store = new MemoryControlStore();
    await store.putRunnerCredential({ name: NAME, value: 'real'.repeat(11), nowMs: 1 });

    for (const value of ['', '   ', '${PIXIV_REFRESH_TOKEN}', 'short']) {
      const response = await handleControl(
        new Request(`https://cp.test/control/credentials/${NAME}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ value }),
        }),
        store,
        new URL(`https://cp.test/control/credentials/${NAME}`),
        SECRET
      );
      expect(response!.status, `value ${JSON.stringify(value)}`).toBe(400);
    }
    // The stored value is unchanged: a rejected write must not have landed.
    expect((await store.readRunnerCredentialSecret(NAME))!.value).toBe('real'.repeat(11));
  });

  it('reveals the value only through an explicit POST', async () => {
    const store = new MemoryControlStore();
    await store.putRunnerCredential({ name: NAME, value: 'd'.repeat(43), nowMs: 1 });
    const path = `/control/credentials/${NAME}`;

    expect((await request(store, 'GET', path))!.status).toBe(200);
    const read = await request(store, 'POST', `${path}/read`);
    expect(((await read!.json()) as { value: string }).value).toBe('d'.repeat(43));
    // A GET on the read path must not work: that is the shape that gets cached.
    expect((await request(store, 'GET', `${path}/read`))!.status).toBe(405);
  });

  it('fails closed without the bearer secret', async () => {
    const store = new MemoryControlStore();
    for (const path of [
      `/control/credentials/${NAME}`,
      `/control/credentials/${NAME}/read`,
    ]) {
      expect((await request(store, 'GET', path, { secret: 'wrong' }))!.status).toBe(401);
      expect((await request(store, 'POST', path, { secret: null }))!.status).toBe(401);
    }
  });

  it('reports an unstored credential rather than inventing one', async () => {
    const store = new MemoryControlStore();
    const meta = (await (await request(store, 'GET', `/control/credentials/absent`))!.json()) as unknown;
    expect(meta).toEqual({ ok: true, name: 'absent', stored: false });
    expect((await request(store, 'POST', `/control/credentials/absent/read`))!.status).toBe(404);
  });
});

describe('secret comparison', () => {
  it('accepts only an exact match', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
    expect(secretsMatch('', '')).toBe(true);
  });
});

describe('the collection and removal', () => {
  it('lists aliases without their values', async () => {
    const store = new MemoryControlStore();
    await store.putRunnerCredential({ name: 'pixiv-main', value: 'a'.repeat(43), nowMs: 1 });
    await store.putRunnerCredential({ name: 'pixiv-alt', value: 'b'.repeat(43), nowMs: 2 });

    const body = (await (await request(store, 'GET', '/control/credentials'))!.json()) as {
      count: number;
      credentials: Array<{ name: string }>;
    };

    expect(body.count).toBe(2);
    expect(body.credentials.map((c) => c.name)).toEqual(['pixiv-alt', 'pixiv-main']);
    // Two accounts is a value, not a code change: the identity is the alias.
    expect(JSON.stringify(body)).not.toContain('a'.repeat(43));
  });

  it('removes an alias and reports an absent one honestly', async () => {
    const store = new MemoryControlStore();
    await store.putRunnerCredential({ name: 'pixiv-alt', value: 'c'.repeat(43), nowMs: 1 });

    const removed = await request(store, 'DELETE', '/control/credentials/pixiv-alt');
    expect(((await removed!.json()) as { removed: boolean }).removed).toBe(true);
    expect(store.events.some((e) => e.event === 'runner_credential_removed')).toBe(true);

    expect((await request(store, 'DELETE', '/control/credentials/pixiv-alt'))!.status).toBe(404);
    expect((await store.listRunnerCredentials()).length).toBe(0);
  });

  it('fails closed on the collection too', async () => {
    const store = new MemoryControlStore();
    expect((await request(store, 'GET', '/control/credentials', { secret: 'wrong' }))!.status).toBe(401);
    expect((await request(store, 'DELETE', '/control/credentials/pixiv-main', { secret: null }))!.status).toBe(401);
  });
});
