import { describe, it, expect, afterEach } from 'vitest';
import { encryptSecret, decryptSecret } from '../secretBox.ts';

const ORIGINAL_KEY = process.env.RROS_TOKEN_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.RROS_TOKEN_KEY;
  else process.env.RROS_TOKEN_KEY = ORIGINAL_KEY;
});

describe('secretBox — tokens at rest', () => {
  it('round-trips a Gmail refresh token', () => {
    const token = '1//0gRefreshToken-not-a-real-one';
    const stored = encryptSecret(token);
    expect(stored.startsWith('v1:')).toBe(true);
    expect(stored).not.toContain(token);
    expect(decryptSecret(stored)).toBe(token);
  });

  it('two encryptions of the same secret differ (random IV)', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('a tampered ciphertext fails the auth tag, loudly', () => {
    const stored = encryptSecret('imap-password-123');
    const parts = stored.split(':');
    parts[2] = Buffer.from('forged').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  it('a different key cannot decrypt', async () => {
    const stored = encryptSecret('secret-a');
    process.env.RROS_TOKEN_KEY = 'another-key';
    // Force the cached key to reload by reimporting the module.
    const fresh = await import('../secretBox.ts');
    expect(() => fresh.decryptSecret(stored)).toThrow();
  });
});
