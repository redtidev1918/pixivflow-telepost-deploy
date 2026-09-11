import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Deployment glue only.
 *
 * This repository used to hold a second copy of the Pixiv domain: occurrences,
 * executions, a credential broker, a review state machine, a publish path and a
 * D1 schema for all of it. Every one of those was a second answer to a question
 * that already had an owner, and the two answers disagreed at the worst possible
 * moment (the submission bot's webhook was pointed at the Worker, whose handler
 * acknowledged every update and dropped it).
 *
 * These tests are the guard rail: the Worker decides *when*, and nothing else.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const CODE_DIRS = ['control-plane/src', 'control-plane/test', 'fly', 'scripts', 'docker', '.github/workflows'];
const CODE_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.sh', '.bash', '.py', '.yml', '.yaml', '.toml', '.sql'];

/** Naming the forbidden things is this file's job, so it would always match itself. */
const SELF = 'control-plane/test/no-business-state.test.ts';

const COMMENT_PREFIX = /^(#|\/\/|\*|\/\*|<!--|--)/;

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '.wrangler') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

function executableLines(file: string): Array<{ number: number; text: string }> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((raw, index) => ({ number: index + 1, text: raw.trim() }))
    .filter(({ text }) => text.length > 0 && !COMMENT_PREFIX.test(text));
}

/** Domain state and the machinery that would recreate it. */
const FORBIDDEN_IMPLEMENTATIONS: Array<{ pattern: RegExp; because: string }> = [
  { pattern: /\bCREATE\s+TABLE\b/i, because: 'schema belongs to PixivFlow/TelePost, not to the clock' },
  { pattern: /\bD1Database\b/, because: 'the D1 shadow ledger was removed on purpose' },
  { pattern: /\bslot_occurrences\b|\bslot_items\b|\bprocessed_works\b/, because: 'PixivFlow owns the slot ledger' },
  { pattern: /\brunner_credentials\b/, because: 'PixivFlow owns the credential it runs with' },
  { pattern: /\breview(s)?\.(approve|reject)\b|\bapproveReview\b/, because: 'TelePost owns review decisions' },
];

/**
 * A tighter rule for the clock itself. Elsewhere in this repository a read-only
 * ops script may legitimately ask Telegram about a webhook owner, or push a
 * channel mapping into TelePost's policy; the Worker must not know the word.
 */
const FORBIDDEN_IN_CLOCK: Array<{ pattern: RegExp; because: string }> = [
  { pattern: /telegram/i, because: 'the clock never talks to Telegram' },
  { pattern: /\bchannel(_id|Id)?\b/, because: 'publishing to Telegram is TelePost-only' },
  { pattern: /\bBOT[0-9]+_TOKEN\b/, because: 'bot credentials belong to TelePost' },
  // Read-only ops scripts elsewhere may open another plane's SQLite file. The
  // clock may not: a database handle here is how the shadow ledger started.
  { pattern: /\b(Database|prepare)\s*\(/, because: 'the Worker must not open a database at all' },
];

describe('the clock owns no domain state', () => {
  it('keeps exactly the three files a clock needs', () => {
    const files = readdirSync(join(REPO_ROOT, 'control-plane/src')).sort();
    expect(files).toEqual(['cron-map.ts', 'dispatch.ts', 'index.ts']);
  });

  it('has no migrations, no D1 config and no business config directory', () => {
    for (const path of ['control-plane/migrations', 'control-plane/config', 'control-plane/data']) {
      expect(existsSync(join(REPO_ROOT, path)), `${path} must not exist`).toBe(false);
    }
    const sqlFiles = collectFiles(join(REPO_ROOT, 'control-plane')).filter((file) => file.endsWith('.sql'));
    expect(sqlFiles).toEqual([]);
  });

  it('mentions no forbidden implementation in code', () => {
    const offenders: string[] = [];
    for (const dir of CODE_DIRS) {
      for (const file of collectFiles(join(REPO_ROOT, dir))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === SELF) continue;
        for (const { number, text } of executableLines(file)) {
          for (const { pattern, because } of FORBIDDEN_IMPLEMENTATIONS) {
            if (pattern.test(text)) offenders.push(`${rel}:${number}: ${text}  (${because})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the clock ignorant of Telegram entirely', () => {
    const files = [
      ...collectFiles(join(REPO_ROOT, 'control-plane/src')),
      join(REPO_ROOT, 'control-plane/wrangler.toml'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO_ROOT, file);
      for (const { number, text } of executableLines(file)) {
        for (const { pattern, because } of FORBIDDEN_IN_CLOCK) {
          if (pattern.test(text)) offenders.push(`${rel}:${number}: ${text}  (${because})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runs no removed execution plane from CI', () => {
    const workflows = readdirSync(join(REPO_ROOT, '.github/workflows'));
    // One-off executor machines and the egress probe belonged to the topology that
    // was replaced by the external-clock worker.
    expect(workflows).not.toContain('pixivflow-batch.yml');
    expect(workflows).not.toContain('egress-probe.yml');
    for (const name of workflows) {
      const text = readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8');
      expect(text, name).not.toMatch(/wrangler\s+d1/);
      expect(text, name).not.toMatch(/PIXIVFLOW_REF/);
    }
  });
});
