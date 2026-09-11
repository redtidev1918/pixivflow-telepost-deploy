import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRONS } from '../src/cron-map';

/**
 * Deployment contract: the glue between the three planes is a handful of strings,
 * and those strings have to agree. This file is the place where "wrangler says
 * one thing, the Worker does another" fails loudly instead of at 10:00.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** Quotes are optional in TOML for simple strings; accept either. */
function quoted(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*['"]([^'"]+)['"]`, 'm').exec(text);
  return match?.[1];
}

/**
 * Comments explain why a binding is absent ("there is deliberately no
 * [[d1_databases]] here"), so a negative assertion has to read configuration,
 * not prose.
 */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('cloudflare clock', () => {
  const wrangler = read('control-plane/wrangler.toml');
  const config = withoutComments(wrangler);

  it('declares exactly the crons the Worker can map', () => {
    const line = /^\s*crons\s*=\s*\[([^\]]*)\]/m.exec(config);
    expect(line, 'wrangler.toml must declare [triggers] crons').not.toBeNull();
    // Cron expressions contain commas, so the entries are the quoted strings.
    const declared = [...line![1]!.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]!);

    expect(declared).toHaveLength(2);
    // A cron that fires without a binding is a silently skipped schedule; a binding
    // without a cron is a schedule that never runs. Both are caught here.
    expect([...declared].sort()).toEqual([...CRONS].sort());
  });

  it('keeps no second ledger: no D1, no queue, no KV', () => {
    expect(config).not.toMatch(/\[\[d1_databases\]\]/);
    expect(config).not.toMatch(/\[\[queues\./);
    expect(config).not.toMatch(/\[\[kv_namespaces\]\]/);
    expect(existsSync(join(REPO_ROOT, 'control-plane/migrations'))).toBe(false);
  });

  it('points at the executor over public HTTPS with a bearer, nothing else', () => {
    const base = quoted(config, 'PIXIVFLOW_TRIGGER_BASE_URL');
    expect(base, 'the trigger origin is deployment glue and belongs in wrangler.toml').toBeTruthy();
    expect(base!).toMatch(/^https:\/\//);
    // The token is a secret: it must never be inlined next to the origin.
    expect(config).not.toMatch(/SCHEDULER_TRIGGER_TOKEN\s*=/);
    expect(read('control-plane/src/index.ts')).toContain('SCHEDULER_TRIGGER_TOKEN');
  });
});

describe('topology has a single source', () => {
  it('ships exactly two Fly configs', () => {
    const configs = readdirSync(join(REPO_ROOT, 'fly'))
      .filter((name) => name.endsWith('.toml'))
      .sort();
    // A third Fly config is how the mixed topology came back last time: two files
    // that both looked authoritative and disagreed about who runs PixivFlow.
    expect(configs).toEqual(['deploy.pixivflow.toml', 'deploy.telepost.toml']);
  });

  it('keeps no second clock and no one-shot executor', () => {
    expect(existsSync(join(REPO_ROOT, 'scheduler'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'fly/executor'))).toBe(false);
    expect(existsSync(join(REPO_ROOT, 'docker/pixivflow-executor.Dockerfile'))).toBe(false);
  });
});

describe('pixivflow worker topology', () => {
  const fly = read('fly/deploy.pixivflow.toml');

  it('wakes on a trigger and lets the ledger decide when to stop', () => {
    expect(fly).toMatch(/auto_start_machines\s*=\s*true/);
    expect(fly).toMatch(/auto_stop_machines\s*=\s*false/);
    expect(fly).toMatch(/min_machines_running\s*=\s*0/);
    expect(fly).toMatch(/\[restart\][\s\S]*?policy\s*=\s*['"]no['"]/);
  });

  it('carries no liveness probe that would fight the stopped state', () => {
    // A probe is a request, and a request wakes a stopped machine. A worker that
    // just finished would be restarted forever by its own health check.
    expect(fly).not.toMatch(/\[\[http_service\.checks\]\]/);
    expect(fly).not.toMatch(/\[\[checks\]\]/);
  });

  it('keeps the ledger on the volume and the config in the image', () => {
    expect(fly).toMatch(/destination\s*=\s*['"]\/app\/data['"]/);
    const configPath = quoted(fly, 'PIXIV_DOWNLOADER_CONFIG');
    expect(configPath, 'the versioned config is baked into the image').toBe('/app/config/pixivflow.production.json');
  });

  it('builds from an immutable ref, never a branch', () => {
    const ref = quoted(fly, 'PIXIVFLOW_REF');
    expect(ref).toBeTruthy();
    // 40-char commit, or a release tag. `master`/`main`/`feat/*` are all wrong:
    // same build arg -> cached clone layer -> an image that claims to be fresh and
    // runs last week's code.
    expect(ref!).toMatch(/^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/);
    expect(read('docker/pixivflow-scheduler.Dockerfile')).not.toMatch(/ARG\s+PIXIVFLOW_REF\s*=/);
  });
});

describe('pixivflow runtime config', () => {
  const config = JSON.parse(read('pixivflow/config/production.json')) as {
    schedulerRuntime: Record<string, unknown>;
    storage: Record<string, string>;
    delivery: { targets: Record<string, { type: string; url: string; fields: Record<string, string> }> };
  };
  const runtime = config.schedulerRuntime;

  it('runs on the external clock and exits when its own ledger is empty', () => {
    expect(runtime.mode).toBe('external');
    expect(runtime.exitWhenIdle).toBe(true);
    // A config that can be reloaded while a run is in flight is a second source of
    // truth about what is scheduled.
    expect(runtime.watchConfig).toBe(false);
    expect(runtime.catchUpMissedRuns).toBe(false);
    expect(Number(runtime.idleGraceMs)).toBeGreaterThanOrEqual(600_000);
    expect(Number(runtime.maxLifetimeMs)).toBeGreaterThan(Number(runtime.idleGraceMs));
  });

  it('exposes the trigger port the Fly app forwards to', () => {
    const trigger = runtime.trigger as { port: number; host: string } | undefined;
    expect(trigger?.port).toBe(8090);
    expect(trigger?.host).toBe('0.0.0.0');
    expect(read('fly/deploy.pixivflow.toml')).toContain("internal_port = 8090");
  });

  it('puts every mutable path on the volume, never in the image', () => {
    expect(config.storage.databasePath).toMatch(/^\/app\/data\//);
    for (const key of ['downloadDirectory', 'illustrationDirectory', 'novelDirectory']) {
      expect(config.storage[key], key).toMatch(/^\/app\/data\//);
    }
  });

  it('delivers finished work to TelePost and can do nothing else', () => {
    const targets = Object.entries(config.delivery.targets);
    expect(targets.length).toBeGreaterThan(0);
    for (const [name, target] of targets) {
      // `telegram` here would be a publishing credential inside an execution
      // machine, and a way to bypass review entirely.
      expect(target.type, name).toBe('httpMultipart');
      expect(target.url, name).toContain('/v1/submissions');
      expect(target.url, name).toContain('${TELEPOST_API_BASE_URL}');
      // A stable key is what makes a re-delivery after a crash a no-op instead of a
      // second review request for the same work.
      expect(target.fields.idempotency_key, name).toBe('{{idempotencyKey}}');
    }
  });
});

describe('telepost service topology', () => {
  const fly = read('fly/deploy.telepost.toml');

  it('never sleeps: a cold start is user-visible', () => {
    expect(fly).toMatch(/auto_stop_machines\s*=\s*false/);
    expect(fly).toMatch(/min_machines_running\s*=\s*1/);
  });

  it('accepts private-network submissions while the webhook stays on public HTTPS', () => {
    // A 301 from the Fly proxy would turn the worker's delivery into a dead end.
    expect(fly).toMatch(/force_https\s*=\s*false/);
  });

  it('pins a released image and holds no execution-plane configuration', () => {
    const image = quoted(fly, 'TELEPOST_IMAGE');
    expect(image).toBeTruthy();
    expect(image!).toMatch(/:\d+\.\d+\.\d+$/);
    expect(fly).not.toMatch(/PIXIVFLOW_|PIXIV_|NODE_OPTIONS|SCHEDULER_TRIGGER/);
  });
});
