/**
 * Secret comparison and one-way digests for the control plane.
 *
 * WebCrypto only: `node:crypto` does not exist in the Workers runtime.
 */

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Length is not hidden — it is not a secret here, since a Pixiv token has a known
 * shape — but every byte is compared, so a matching prefix cannot be detected by
 * measuring how early the comparison returned.
 */
export function secretsMatch(
  presented: string,
  expected: string,
  subtle?: { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean }
): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  if (subtle?.timingSafeEqual) return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * A short one-way digest of a credential.
 *
 * Exists so a rotation can be recorded as "the value this replaced was <digest>"
 * and so an audit line can name a credential without disclosing it. Never the
 * value itself, and never reversible in practice.
 */
export async function hashSecret(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
