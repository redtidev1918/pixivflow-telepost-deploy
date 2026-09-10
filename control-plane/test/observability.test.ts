import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { clockHealth } from '../src/index';
import {
  SWEEP_INTERVAL_MINUTES,
  SWEEP_LATE_MINUTES,
  SWEEP_STALLED_MINUTES,
} from '../src/schedules';
import type { ReconciliationRunRow } from '../src/store';

const NOW = Date.UTC(2026, 8, 11, 4, 0, 0);

function sweep(startedAt: number): ReconciliationRunRow {
  return {
    id: 'sweep',
    startedAt,
    finishedAt: startedAt + 200,
    summary: { created: 1, dispatched: 1, reconciled: 0, retried: 0, expired: 0, errors: [] },
  };
}

/**
 * The cron is the only clock in this architecture. A lost tick used to be
 * invisible until an occurrence was missing hours later, so the liveness of the
 * sweep has to be answerable from durable state rather than from log archives.
 */
describe('clock health', () => {
  it('reports unknown before the first sweep instead of claiming ok', () => {
    expect(clockHealth([], NOW)).toEqual({ lastSweepAt: null, ageMinutes: null, state: 'unknown' });
  });

  it('is ok within one interval', () => {
    const health = clockHealth([sweep(NOW - 4 * 60_000)], NOW);
    expect(health.state).toBe('ok');
    expect(health.ageMinutes).toBe(4);
  });

  it('is late past the grace window', () => {
    const health = clockHealth([sweep(NOW - (SWEEP_LATE_MINUTES + 1) * 60_000)], NOW);
    expect(health.state).toBe('late');
  });

  it('is stalled once several intervals have been missed', () => {
    const health = clockHealth([sweep(NOW - (SWEEP_STALLED_MINUTES + 1) * 60_000)], NOW);
    expect(health.state).toBe('stalled');
  });

  it('judges by the most recent sweep, not the first row it was given', () => {
    const health = clockHealth([sweep(NOW - 2 * 60_000), sweep(NOW - 900 * 60_000)], NOW);
    expect(health.state).toBe('ok');
    expect(health.lastSweepAt).toBe(NOW - 2 * 60_000);
  });
});

/**
 * `SWEEP_INTERVAL_MINUTES` is only meaningful if it still describes the deployed
 * cron. Nothing else ties the constant to `wrangler.toml`, so a change to the
 * trigger would silently make the status endpoint lie.
 */
describe('the declared sweep interval matches the deployed cron', () => {
  it('agrees with the crons entry in wrangler.toml', () => {
    const toml = readFileSync(join(__dirname, '..', 'wrangler.toml'), 'utf8');
    const match = toml.match(/^crons\s*=\s*\[(.*)\]\s*$/m);
    expect(match, 'wrangler.toml must declare a crons array').not.toBeNull();
    const body = match?.[1] ?? '';
    const crons = (body.match(/"([^"]+)"/g) ?? []).map((entry) => entry.replace(/"/g, ''));

    // A single periodic sweep, not one cron per schedule: the interval is the
    // number of minutes in the `*/N` step.
    expect(crons).toHaveLength(1);
    const cron: string = crons[0]!;
    const step = cron.match(/^\*\/(\d+) \* \* \* \*$/);
    expect(step, `expected a */N * * * * cron, got "${cron}"`).not.toBeNull();
    expect(Number(step?.[1])).toBe(SWEEP_INTERVAL_MINUTES);
  });
});
