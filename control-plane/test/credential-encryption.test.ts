import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, generateMasterKey, isEncrypted } from '../src/credentials';

/**
 * A refresh token is the whole account. "The API does not return it" is not the same
 * property as "the database does not contain it": a dump, a backup or a SELECT in a
 * support session would be enough to take the account over.
 */
describe('credential encryption at rest', () => {
  const key = generateMasterKey();

  it('round-trips a token', async () => {
    const token = 'mTXbhouCtuE0ZerUPMCQ2XUbkw0mvtUs8KZ83VqZ6Mg';
    const stored = await encryptSecret(token, key);

    expect(isEncrypted(stored)).toBe(true);
    expect(stored).not.toContain(token);
    expect(await decryptSecret(stored, key)).toBe(token);
  });

  it('uses a fresh IV per write, so the same token never stores the same bytes', async () => {
    const [a, b] = await Promise.all([encryptSecret('same-token', key), encryptSecret('same-token', key)]);
    expect(a).not.toBe(b);
  });

  it('refuses to decrypt with a different key', async () => {
    const stored = await encryptSecret('secret', key);
    await expect(decryptSecret(stored, generateMasterKey())).rejects.toThrow();
  });

  it('detects tampering instead of returning garbage', async () => {
    const stored = await encryptSecret('secret', key);
    // Flip a byte in the ciphertext.
    const body = stored.slice(3);
    const tampered = `${stored.slice(0, 3)}${body.slice(0, -2)}${body.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    await expect(decryptSecret(tampered, key)).rejects.toThrow();
  });

  it('reads a legacy plaintext value unchanged', async () => {
    // Deployable without a migration window: an existing credential keeps working
    // until the next write re-encrypts it.
    const legacy = 'mTXbhouCtuE0ZerUPMCQ2XUbkw0mvtUs8KZ83VqZ6Mg';
    expect(isEncrypted(legacy)).toBe(false);
    expect(await decryptSecret(legacy, key)).toBe(legacy);
  });

  it('rejects a master key that is not 32 bytes', async () => {
    await expect(encryptSecret('x', btoa('short'))).rejects.toThrow(/32 bytes/);
  });
});
