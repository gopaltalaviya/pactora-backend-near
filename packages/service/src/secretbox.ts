import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

/**
 * Small secrets at rest (a webhook's signing secret): AES-256-GCM under one
 * 32-byte key from the environment. The stored form is
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64url, so a value encrypted
 * under another scheme or key is refused rather than misread.
 *
 * The key is never derived from a passphrase here: it must already be 32
 * random bytes (64 hex characters or 43/44 base64), which is what the
 * startup check asks for.
 */

const VERSION = 'v1';

/** The 32-byte key from its hex or base64 form, or an error saying what is wrong. */
export function parseSecretKey(raw: string): Buffer {
  const text = raw.trim();
  const bytes = /^[0-9a-fA-F]{64}$/.test(text)
    ? Buffer.from(text, 'hex')
    : /^[A-Za-z0-9+/_-]{43}={0,1}$/.test(text)
      ? Buffer.from(text, text.includes('-') || text.includes('_') ? 'base64url' : 'base64')
      : null;
  if (!bytes || bytes.length !== 32) {
    throw new Error('must be 32 random bytes: 64 hex characters or 44 base64 characters');
  }
  // 32 copies of one byte is the right length and no secret at all (`'7e'.repeat(32)`,
  // `'0'.repeat(64)`): refused, as is anything with fewer than 8 distinct bytes.
  if (new Set(bytes).size < 8) {
    throw new Error(
      'must be 32 random bytes: this value repeats too few distinct bytes to be random (openssl rand -hex 32)',
    );
  }
  return bytes;
}

/** GCM's full tag. Fixed on both sides (audit I2): a shortened tag is refused, never accepted as a shorter one. */
const TAG_BYTES = 16;

export function seal(key: Buffer, plaintext: string, aad = ''): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, {authTagLength: TAG_BYTES});
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

/**
 * The plaintext, or a thrown error: a wrong key, a changed byte, a different
 * `aad` (the row it belongs to) or an unknown version all fail the same way.
 */
export function open(key: Buffer, sealed: string, aad = ''): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('not a sealed secret');
  const [iv, tag, ct] = parts.slice(1).map((p) => Buffer.from(p, 'base64url'));
  if (tag!.length !== TAG_BYTES)
    throw new Error('not a sealed secret: the authentication tag is not 16 bytes');
  const decipher = createDecipheriv('aes-256-gcm', key, iv!, {authTagLength: TAG_BYTES});
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ct!), decipher.final()]).toString('utf8');
}
