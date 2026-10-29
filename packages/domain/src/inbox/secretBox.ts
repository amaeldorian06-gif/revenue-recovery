import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Token encryption at rest. The prompt asks for pgcrypto + a KMS key; the
 * sandbox's embedded Postgres has no pgcrypto, so the same cipher family
 * (AES-256-GCM) runs in the app layer, keyed by `RROS_TOKEN_KEY` — the
 * KMS-managed key in production, a dev default here. Ciphertext never crosses
 * this module in plaintext log calls, and the format is versioned so a move
 * back into SQL (pgcrypto) can decrypt what previous versions wrote.
 */

const DEV_KEY_MATERIAL = 'rros-dev-token-key-not-for-production';
let cached: { material: string; key: Buffer } | null = null;

function key(): Buffer {
  const material = process.env.RROS_TOKEN_KEY ?? DEV_KEY_MATERIAL;
  if (!cached || cached.material !== material) {
    cached = { material, key: createHash('sha256').update(`rros:v1:${material}`).digest() };
  }
  return cached.key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const [version, ivB64, ctB64, tagB64] = stored.split(':');
  if (version !== 'v1' || !ivB64 || !ctB64 || !tagB64) {
    throw new Error('secretBox: unknown payload');
  }
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
