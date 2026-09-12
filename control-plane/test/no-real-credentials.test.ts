/**
 * SECURITY GUARD — real credentials must never enter this repository again.
 *
 * Why this file exists (2026-09-12 SEV-1 incident):
 *   `control-plane/test/credential-encryption.test.ts` was once committed with a
 *   **real** Pixiv refresh token hardcoded as a "fixture". The value reached the
 *   public `main` history and was clone-reachable until the file was deleted.
 *   Deleting a file does not delete history, so the only durable controls are
 *   (a) rotate the credential and (b) refuse to ever commit it again.
 *
 * What this guard enforces:
 *   1. No Telegram Bot API token shape may appear in a TRACKED file.
 *   2. No Pixiv refresh-token literal may appear in a TRACKED file unless it is
 *      unmistakably synthetic (EXAMPLE / SYNTHETIC / …).
 *   3. Known compromised values are blocked by sha256 fingerprint, so the secret
 *      itself never has to be written down to keep it out.
 *
 * Scope is `git ls-files`: a developer's local, gitignored credential is out of
 * scope — this guard is about what is *committed*.
 *
 * Nothing here ever prints a matched value: findings are `<REDACTED>` + digest.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(__dirname, '..', '..');
const SELF_RELATIVE = 'control-plane/test/no-real-credentials.test.ts';

/** Telegram Bot API token: <bot_id 8-10 digits>:<35 char body>. */
const TELEGRAM_TOKEN = /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g;
/** Telegram supergroup / channel id. */
const TELEGRAM_CHAT_ID = /-100\d{10,}/g;
/** A refresh token literal: `"refreshToken": "<30+ url-safe chars>"`. */
const PIXIV_REFRESH_TOKEN = /"?refresh[_-]?token"?\s*[:=]\s*["']([A-Za-z0-9_-]{30,})["']/gi;

/**
 * sha256 fingerprints of credentials confirmed compromised during the
 * 2026-09-12 SEV-1 incident. Secrets are revoked; only the digest is kept.
 *
 * The last entry is the value that leaked through this repository's public
 * history (`control-plane/test/credential-encryption.test.ts`, PR #23 → `539befd`).
 */
const COMPROMISED_SHA256 = new Set<string>([
  '57d41efb367ef1a8a2db263abb1c080a9067611b09f9ee072b9fb4eaaa5511d0', // bot token historically committed as a test fixture
  '489e0fb128cf777f892e0c5bec11123f12cc8526c5b9f60c0935c12a956d2404', // production chat id
  'fd9ea6f06073b3e3d6f3ec7ca43e15849032c7b501de276c2a6025657a9273c7', // Pixiv refresh token found in a local config copy
  '722c05473f2ad7d215c73d5a0959dc5b8b6c0f4deba81a62c3839ea7e02ab414', // Pixiv refresh token leaked via this repo's public git history
]);

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** A chat id is synthetic when its digits repeat (e.g. -1001111111111). */
function isSyntheticChatId(value: string): boolean {
  return /^-100(\d)\1+$/.test(value);
}

/** A refresh token body is synthetic when it is obviously not a live credential. */
function isSyntheticRefreshToken(body: string): boolean {
  return /EXAMPLE|SYNTHETIC|FAKE|DUMMY|PLACEHOLDER|NOT_A_REAL|REDACTED|^test\d+$|^A{30,}$/i.test(body);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'logs', 'cache']);
const TEXT_EXT = new Set(['.ts', '.js', '.cjs', '.mjs', '.json', '.yml', '.yaml', '.sh', '.md', '.txt']);

function isTextFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && TEXT_EXT.has(name.slice(dot));
}

/** Committed files only — a developer's local, ignored secrets are out of scope. */
function listTrackedFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'buffer' });
    return out.toString('utf8').split('\0').filter(Boolean).filter(isTextFile);
  } catch {
    return walk(REPO_ROOT)
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .filter(isTextFile);
  }
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, out);
    } else if (isTextFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  fingerprint: string;
  reason: string;
}

function scan(files: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (file === SELF_RELATIVE) continue;
    let content: string;
    try {
      content = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      continue;
    }
    content.split(/\r?\n/).forEach((line, index) => {
      const consider = (value: string, shape: 'bot-token' | 'chat-id' | 'refresh-token'): void => {
        const digest = sha256(value);
        if (COMPROMISED_SHA256.has(digest)) {
          findings.push({ file, line: index + 1, fingerprint: `sha256:${digest}`, reason: 'known compromised credential' });
          return;
        }
        if (shape === 'bot-token') {
          findings.push({ file, line: index + 1, fingerprint: `sha256:${digest}`, reason: 'bot token shape committed' });
          return;
        }
        if (shape === 'chat-id' && !isSyntheticChatId(value)) {
          findings.push({ file, line: index + 1, fingerprint: `sha256:${digest}`, reason: 'real-looking chat id committed' });
          return;
        }
        if (shape === 'refresh-token' && !isSyntheticRefreshToken(value)) {
          findings.push({ file, line: index + 1, fingerprint: `sha256:${digest}`, reason: 'real-looking refresh token committed' });
        }
      };

      for (const match of line.match(TELEGRAM_TOKEN) ?? []) consider(match, 'bot-token');
      for (const match of line.match(TELEGRAM_CHAT_ID) ?? []) consider(match, 'chat-id');
      PIXIV_REFRESH_TOKEN.lastIndex = 0;
      let refresh: RegExpExecArray | null;
      while ((refresh = PIXIV_REFRESH_TOKEN.exec(line)) !== null) consider(refresh[1], 'refresh-token');
    });
  }
  return findings;
}

describe('security guard: no real credentials committed to the deployment repository', () => {
  const files = listTrackedFiles();
  const render = (findings: Finding[]): string[] =>
    findings.map((f) => `${f.file}:${f.line} <REDACTED> ${f.fingerprint} (${f.reason})`);

  it('scans a non-trivial number of committed files (guard is actually running)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('contains no real-looking or known-compromised credentials', () => {
    expect(render(scan(files))).toEqual([]);
  });

  it('still blocks the value leaked through this repository history', () => {
    const leakedFingerprint = '722c05473f2ad7d215c73d5a0959dc5b8b6c0f4deba81a62c3839ea7e02ab414';
    expect(COMPROMISED_SHA256.has(leakedFingerprint)).toBe(true);
  });
});
