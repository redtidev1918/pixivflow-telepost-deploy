/**
 * Application-layer encryption for stored credentials.
 *
 * A refresh token is the whole account. Storing it as plaintext in D1 means a
 * database dump, a backup, or a `SELECT` in a support session is enough to take the
 * account over — the API never returning it is not the same property.
 *
 * Format: `v1:<base64(iv || ciphertext || tag)>`, AES-GCM with a 12-byte IV and a
 * fresh IV per write. The version prefix is what makes this deployable without a
 * migration window: a value that does not carry it is legacy plaintext and is read
 * as-is, so an existing credential keeps working and is re-encrypted the next time
 * it is written.
 */

const PREFIX = 'v1:';
const IV_BYTES = 12;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True when the stored value is ciphertext rather than a legacy plaintext value. */
export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

async function importKey(masterKey: string): Promise<CryptoKey> {
  // The key is supplied as base64 of 32 raw bytes; anything shorter is a
  // configuration error rather than something to paper over with a hash.
  const raw = fromBase64(masterKey);
  if (raw.byteLength !== 32) {
    throw new Error('CREDENTIAL_MASTER_KEY must be base64 of exactly 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plaintext: string, masterKey: string): Promise<string> {
  const key = await importKey(masterKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  );
  const combined = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.byteLength);
  return `${PREFIX}${base64(combined)}`;
}

/**
 * Decrypt a stored value, passing legacy plaintext through unchanged.
 *
 * Throwing on a malformed ciphertext is deliberate: silently returning the
 * ciphertext would hand the runner a value that cannot authenticate and turn a
 * configuration mistake into a confusing Pixiv auth failure.
 */
export async function decryptSecret(stored: string, masterKey: string): Promise<string> {
  if (!isEncrypted(stored)) return stored;
  const key = await importKey(masterKey);
  const combined = fromBase64(stored.slice(PREFIX.length));
  const iv = combined.subarray(0, IV_BYTES);
  const ciphertext = combined.subarray(IV_BYTES);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/** A fresh 32-byte master key, base64. Used by the setup tooling, never at runtime. */
export function generateMasterKey(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)));
}
