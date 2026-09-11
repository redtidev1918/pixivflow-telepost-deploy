import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Production contract: the submission bot's Telegram webhook has exactly ONE
 * owner, and that owner is TelePost.
 *
 * What went wrong once already: the Worker was appointed as the bot's webhook and
 * its handler answered every `message` update with `200 {ok:true}`, so Telegram
 * reported a perfectly healthy webhook while every private-chat submission was
 * acknowledged and thrown away. Nothing in the pipeline treated that as an error,
 * which is why it survived until someone noticed the reviews had stopped.
 *
 * The structural invariants that make the same class of accident impossible to
 * re-introduce quietly:
 *   1. nothing in this repository may claim (or release) the Telegram webhook -
 *      registering it is TelePost's startup's job and nobody else's;
 *   2. the execution machine must not hold a Telegram bot token, so it cannot
 *      become a webhook owner even if something asks it to;
 *   3. the execution machine's only way out is TelePost's submission API, so it
 *      cannot publish to a channel and cannot skip review.
 *
 * The live check - "is the webhook still pointing at TelePost right now?" - can
 * only be answered with a bot token and lives in scripts/verify-production.sh.
 */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Directories that ship or run production code. Prose is deliberately excluded. */
const CODE_DIRS = ['control-plane/src', 'control-plane/test', 'fly', 'scripts', 'docker', '.github/workflows'];

const CODE_EXTENSIONS = ['.ts', '.js', '.mjs', '.cjs', '.sh', '.bash', '.py', '.yml', '.yaml', '.toml'];

/** This file names the forbidden calls in order to look for them, so it would always match itself. */
const SELF = 'control-plane/test/webhook-ownership.test.ts';

/** A line whose first non-space characters make it a comment in any of our languages. */
const COMMENT_PREFIX = /^(#|\/\/|\*|\/\*|<!--|--)/;

function collectFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectFiles(full, out);
    else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(full);
  }
  return out;
}

/** Lines that actually execute: comments stripped, blanks dropped. */
function executableLines(file: string): Array<{ number: number; text: string }> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((raw, index) => ({ number: index + 1, text: raw.trim() }))
    .filter(({ text }) => text.length > 0 && !COMMENT_PREFIX.test(text));
}

/**
 * Calls, not mentions. An operator-facing line that talks about re-registering a
 * webhook by hand is fine; a line that actually invokes the API is not.
 */
const CLAIM_CALL_PATTERNS = [
  /\b(setWebhook|deleteWebhook|set_webhook|delete_webhook)\s*\(/,
  /\/bot[^'"`\s]*\/(setWebhook|deleteWebhook)\b/,
  /\/set_webhook\b/,
  /\/delete_webhook\b/,
];

/** Everything an execution machine is allowed to be: a Pixiv client that hands work to TelePost. */
const EXECUTION_PLANE_FILES = [
  'fly/deploy.pixivflow.toml',
  'docker/pixivflow-scheduler.Dockerfile',
  'pixivflow/config/production.json',
];

describe('telegram webhook ownership', () => {
  it('never claims or releases the webhook from this repository', () => {
    const offenders: string[] = [];
    for (const dir of CODE_DIRS) {
      for (const file of collectFiles(join(REPO_ROOT, dir))) {
        const rel = relative(REPO_ROOT, file);
        if (rel === SELF) continue;
        for (const { number, text } of executableLines(file)) {
          if (CLAIM_CALL_PATTERNS.some((pattern) => pattern.test(text))) {
            offenders.push(`${rel}:${number}: ${text}`);
          }
        }
      }
    }
    expect(
      offenders,
      'TelePost owns the submission bot webhook. Registering it from anywhere else is '
        + 'how the submission pipeline was swallowed once already.',
    ).toEqual([]);
  });

  it('gives the execution machine no Telegram credential at all', () => {
    // Not holding a bot token is what stops an execution machine from being able to
    // re-point the submission bot's webhook at itself, or to post to a channel.
    for (const file of EXECUTION_PLANE_FILES) {
      const offenders = executableLines(join(REPO_ROOT, file)).filter(({ text }) =>
        /TELEGRAM|BOT[0-9]_TOKEN|CHANNEL_ID|api\.telegram\.org/i.test(text),
      );
      expect(offenders, `${file} must not carry a Telegram credential`).toEqual([]);
    }
  });

  it('gives the execution machine no way out except the submission API', () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, 'pixivflow/config/production.json'), 'utf8')) as {
      delivery?: { targets?: Record<string, Record<string, unknown>> };
    };
    const targets = Object.entries(config.delivery?.targets ?? {});
    expect(targets.length).toBeGreaterThan(0);
    for (const [name, target] of targets) {
      // A `telegram` target would be a publishing credential in the executor's
      // hands. With none of them, the only thing an execution machine can do with
      // finished work is hand it to TelePost and let TelePost own the decision.
      expect(target.type, name).toBe('httpMultipart');
      expect(String(target.url), name).toContain('/v1/submissions');
      expect(String(target.url), name).toContain('${TELEPOST_API_BASE_URL}');
    }
  });
});
