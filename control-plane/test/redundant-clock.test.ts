import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CRON_MAP, CRONS, PRIMARY_CRONS, SECONDARY_OFFSET_MINUTES, bindingForSchedule } from '../src/cron-map';

/**
 * Production runs TWO independent external clocks over the same schedule set:
 *
 *   PRIMARY    cron-job.org   fires AT the occurrence
 *   SECONDARY  this Worker    fires at the occurrence + SECONDARY_OFFSET_MINUTES
 *
 * The whole arrangement rests on two claims that are easy to get silently wrong:
 *
 *   1. the two clocks name the SAME occurrence, so the slower one converges
 *      instead of running a second batch; and
 *   2. the Worker's cron really is the primary's cron plus the documented offset,
 *      and both really match the schedules declared for the executor.
 *
 * Claim 1 depends on PixivFlow's occurrence resolver and is proved there, against
 * the real resolver, in `PixivFlow/src/__tests__/scheduler/redundantClockOffset.test.ts`.
 * This file proves claim 2 — the three declarations that must never drift:
 *
 *   pixivflow/config/production.json   (Asia/Shanghai, the executor's truth)
 *   control-plane/src/cron-map.ts      (UTC, the secondary clock)
 *   control-plane/wrangler.toml        (UTC, what the platform actually registers)
 *
 * Drift here is not a cosmetic problem: a Worker whose cron no longer sits after
 * the primary stops being a backup and becomes a second, competing trigger.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

interface ScheduleEntry {
  id: string;
  cron: string;
  timezone: string;
  enabled: boolean;
}

function executorSchedules(): ScheduleEntry[] {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'pixivflow/config/production.json'), 'utf8')) as {
    schedules?: ScheduleEntry[];
  };
  return (config.schedules ?? []).filter((entry) => entry.enabled);
}

/** `m h1,h2 * * *` -> `{ minutes: [m], hours: [h1, h2] }`. The shape production uses. */
function parseCron(expression: string): { minutes: number[]; hours: number[] } {
  const fields = expression.trim().split(/\s+/);
  expect(fields, `unsupported cron shape: ${expression}`).toHaveLength(5);
  expect(fields[2]).toBe('*');
  const numbers = (field: string): number[] => field.split(',').map((value) => Number(value));
  return { minutes: numbers(fields[0]!), hours: numbers(fields[1]!) };
}

/** Shift a `m h1,h2 * * *` expression into UTC, assuming a fixed zone offset. */
function toUtc(expression: string, offsetHours: number): string {
  const { minutes, hours } = parseCron(expression);
  const shifted = hours.map((hour) => ((hour - offsetHours) % 24 + 24) % 24).sort((a, b) => a - b);
  return `${minutes[0]} ${shifted.join(',')} * * *`;
}

describe('redundant external clocks', () => {
  it('the executor really runs the two schedules the clocks trigger', () => {
    const schedules = executorSchedules();
    expect(schedules.map((entry) => entry.id).sort()).toEqual(['bot1-daily', 'bot2-daily']);
    // Every schedule must declare its timezone explicitly: a schedule that falls
    // back to the host timezone changes meaning when the host moves.
    for (const entry of schedules) {
      expect(entry.timezone, entry.id).toBe('Asia/Shanghai');
    }
  });

  it('fires a single daily batch at 10:00 / 10:10 Asia/Shanghai (scarce-tag, once per day)', () => {
    // 2026-09-19 decision: once per day for scarce tags (was 10:00 + 22:00).
    // This asserts the executor schedule stays single-daily.
    const byId = new Map(executorSchedules().map((entry) => [entry.id, entry]));
    expect(byId.get('bot1-daily')!.cron).toBe('0 10 * * *');
    expect(byId.get('bot2-daily')!.cron).toBe('10 10 * * *');

    // 10:00 / 10:10 Asia/Shanghai is 02:00Z / 02:10Z. Asserted in UTC too.
    expect(toUtc(byId.get('bot1-daily')!.cron, 8)).toBe('0 2 * * *');
    expect(toUtc(byId.get('bot2-daily')!.cron, 8)).toBe('10 2 * * *');
  });

  it('declares exactly one clock binding per schedule, and every one is secondary', () => {
    const schedules = executorSchedules().map((entry) => entry.id).sort();
    const mapped = Object.values(CRON_MAP).map((binding) => binding.scheduleId).sort();
    expect(mapped).toEqual(schedules);
    // Not one primary: this Worker must never be the only clock, and must not
    // pretend to be the primary one either.
    for (const binding of Object.values(CRON_MAP)) {
      expect(binding.clockRole).toBe('secondary');
    }
    expect(Object.values(CRON_MAP).filter((b) => b.clockRole === 'primary')).toEqual([]);
  });

  it('the secondary cron is the primary cron plus exactly the documented offset', () => {
    for (const [secondaryCron, binding] of Object.entries(CRON_MAP)) {
      const secondary = parseCron(secondaryCron);
      const primary = parseCron(binding.primaryCron);

      // Same hours: the offset is minutes, so it can never move a fire onto a
      // different hour slot and change which occurrence is meant.
      expect(secondary.hours, secondaryCron).toEqual(primary.hours);
      expect(secondary.minutes[0], secondaryCron).toBe(
        primary.minutes[0]! + SECONDARY_OFFSET_MINUTES,
      );
      // A positive offset is mandatory: a clock firing BEFORE the occurrence
      // resolves to the upcoming fire, which is a different occurrence for
      // every schedule that has a lead window.
      expect(SECONDARY_OFFSET_MINUTES).toBeGreaterThan(0);
    }
  });

  it('is a small offset, far inside the bound proved against the real resolver', () => {
    // PixivFlow proves the binding bound with 12-hour spacing and a 720-minute
    // grace: the LEAD window (15 min) binds, so the largest delay that still
    // names the intended occurrence is 704 minutes. Anything near that would be
    // a different, still-valid occurrence — silently the wrong batch.
    const PROVEN_MAX_SAFE_MINUTES = 704;
    expect(SECONDARY_OFFSET_MINUTES).toBeLessThan(PROVEN_MAX_SAFE_MINUTES);
    expect(SECONDARY_OFFSET_MINUTES).toBeLessThanOrEqual(15);
  });

  it('the primary cron the operator must configure is the schedule cron shifted to UTC', () => {
    for (const entry of executorSchedules()) {
      const primaryUtc = toUtc(entry.cron, 8);
      expect(PRIMARY_CRONS, entry.id).toContain(primaryUtc);
      expect(bindingForSchedule(entry.id)?.primaryCron, entry.id).toBe(primaryUtc);
    }
    expect(PRIMARY_CRONS.sort()).toEqual(['0 2 * * *', '10 2 * * *']);
  });

  it('wrangler.toml registers the secondary crons and only those', () => {
    const config = readFileSync(join(REPO_ROOT, 'control-plane/wrangler.toml'), 'utf8');
    const line = /^\s*crons\s*=\s*\[([^\]]*)\]/m.exec(config);
    expect(line, 'wranger.toml must declare [triggers] crons').not.toBeNull();

    // Quoted entries, not a comma split: a cron field is itself comma-separated
    // (`2,14`), so splitting on commas would shred the expressions.
    const declared = [...line![1]!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);

    expect([...declared].sort()).toEqual([...CRONS].sort());
    // The primary expressions belong to cron-job.org's console. If they ever
    // appear here, this Worker has become a second primary instead of a backup.
    for (const primary of PRIMARY_CRONS) {
      expect(declared, `wrangler.toml must not register the primary cron ${primary}`).not.toContain(primary);
    }
  });

  it('keeps the clock stateless: one endpoint, no state bindings', () => {
    // Executable lines only: the file's own header *says* there is no D1 binding,
    // and a comment describing an absence must not read as the presence.
    const config = readFileSync(join(REPO_ROOT, 'control-plane/wrangler.toml'), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    // The redundancy is two clocks over ONE durable execution authority. Any
    // storage here would be a second authority, and a duplicate trigger could
    // stop converging.
    expect(config).not.toMatch(/\[\[d1_databases\]\]/);
    expect(config).not.toMatch(/\[\[kv_namespaces\]\]/);
    expect(config).not.toMatch(/\[\[queues\]\]/);
    expect(config).not.toMatch(/\[\[durable_objects\]\]/);
  });

  it('describes the offset in the operator-facing labels', () => {
    // A label that does not say "secondary, +2 min" is how an operator ends up
    // reading the backup as the primary in a log line.
    for (const binding of Object.values(CRON_MAP)) {
      expect(binding.label).toContain('secondary');
      expect(binding.label).toContain(`+${SECONDARY_OFFSET_MINUTES} min`);
    }
  });
});
