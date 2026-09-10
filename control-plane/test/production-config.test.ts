import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The versioned configs are what the batch runner actually executes at 10:00 and
 * 18:00. A typo in them is not caught by any type system, and it only surfaces
 * once an occurrence is already due. These assertions are the cheap subset that
 * a real dispatcher would otherwise discover too late.
 */
const CONFIG_DIR = join(__dirname, '..', 'config');
const CONFIGS = ['pixivflow.shadow.json', 'pixivflow.production.json'];

interface DeliveryTarget {
  type: string;
  botId?: string;
  botToken?: string;
  chatId?: string;
  publishChatId?: string;
  controlPlaneUrl?: string;
  controlPlaneToken?: string;
  url?: string;
}

interface PixivFlowConfig {
  delivery?: { targets?: Record<string, DeliveryTarget> };
  targets?: Array<{ id: string; delivery?: { target?: string } }>;
  schedules?: unknown;
}

function load(name: string): PixivFlowConfig {
  return JSON.parse(readFileSync(join(CONFIG_DIR, name), 'utf8')) as PixivFlowConfig;
}

describe.each(CONFIGS)('%s', (name) => {
  it('parses as JSON with at least one target', () => {
    const config = load(name);
    expect(config.targets?.length ?? 0).toBeGreaterThan(0);
  });

  it('binds every target to a delivery target that exists', () => {
    const config = load(name);
    const defined = Object.keys(config.delivery?.targets ?? {});
    for (const target of config.targets ?? []) {
      const referenced = target.delivery?.target;
      if (referenced === undefined) continue;
      expect(defined, `${target.id} -> ${referenced}`).toContain(referenced);
    }
  });

  it('never stores a literal secret', () => {
    const config = load(name);
    for (const [targetName, target] of Object.entries(config.delivery?.targets ?? {})) {
      for (const field of ['botToken', 'controlPlaneToken', 'url'] as const) {
        const value = target[field];
        if (value === undefined) continue;
        expect(value, `${targetName}.${field} must be a \${ENV} placeholder`).toMatch(
          /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/,
        );
      }
    }
  });

  it('gives every telegram target the fields the runner requires', () => {
    const config = load(name);
    for (const [targetName, target] of Object.entries(config.delivery?.targets ?? {})) {
      if (target.type !== 'telegram') continue;
      // Any of these missing means the runner cannot post, or cannot report back
      // the ids the control plane needs to publish later.
      expect(target.botId, targetName).toBeTruthy();
      expect(target.botToken, targetName).toBeTruthy();
      expect(target.chatId, targetName).toBeTruthy();
      expect(target.publishChatId, targetName).toBeTruthy();
      expect(target.controlPlaneUrl, targetName).toMatch(/^(\$\{[A-Za-z_][A-Za-z0-9_]*\}|https?:\/\/)/);
      expect(target.controlPlaneToken, targetName).toBeTruthy();
    }
  });

  it('points production publishing at the real channels and nothing else', () => {
    if (name !== 'pixivflow.production.json') return;
    const config = load(name);
    const published = Object.values(config.delivery?.targets ?? {})
      .filter((target) => target.type === 'telegram')
      .map((target) => target.publishChatId);
    expect(published.sort()).toEqual(['@voreShare', '@xgdShare']);
  });

  it('never lets the shadow config publish anywhere real', () => {
    if (name !== 'pixivflow.shadow.json') return;
    const config = load(name);
    // Shadow must be incapable of publishing by construction, not by discipline.
    expect(config.delivery?.targets ?? {}).toEqual({});
    for (const target of config.targets ?? []) {
      expect(target.delivery).toBeUndefined();
    }
  });
});
