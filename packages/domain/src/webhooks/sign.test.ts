/** Criterion 6 (pure half): the t=<ts>,v1=<hmac> scheme, 5-minute tolerance. */
import { describe, it, expect } from 'vitest';
import { signPayload, verifySignature, RETRY_DELAYS_S, MAX_ATTEMPTS } from './sign.ts';

const SECRET = 'whsec_abc123';
const BODY = '{"event":"reply.received","id":"abc"}';

describe('webhook signatures', () => {
  it('a correctly signed payload verifies', () => {
    const header = signPayload(SECRET, BODY, 1_700_000_000_000);
    expect(verifySignature(header, SECRET, BODY, 1_700_000_000_000)).toEqual({ ok: true });
  });

  it('a tampered body fails the signature check', () => {
    const header = signPayload(SECRET, BODY, 1_700_000_000_000);
    expect(verifySignature(header, SECRET, BODY + ' ', 1_700_000_000_000).reason).toBe('signature');
  });

  it('a tampered secret fails', () => {
    const header = signPayload(SECRET, BODY, 1_700_000_000_000);
    expect(verifySignature(header, 'whsec_other', BODY, 1_700_000_000_000).reason).toBe('signature');
  });

  it('a replay past the 5-minute tolerance is refused', () => {
    const header = signPayload(SECRET, BODY, 1_700_000_000_000);
    expect(verifySignature(header, SECRET, BODY, 1_700_000_000_000 + 5 * 60_000 + 1).reason).toBe('tolerance');
  });

  it('within the tolerance it still verifies', () => {
    const header = signPayload(SECRET, BODY, 1_700_000_000_000);
    expect(verifySignature(header, SECRET, BODY, 1_700_000_000_000 + 4 * 60_000).ok).toBe(true);
  });

  it('malformed headers are refused, not thrown', () => {
    expect(verifySignature('garbage', SECRET, BODY).reason).toBe('malformed');
    expect(verifySignature('t=abc,v1=', SECRET, BODY).reason).toBe('malformed');
  });

  it('retry schedule is 10 s, 60 s, 300 s then dead', () => {
    expect([...RETRY_DELAYS_S]).toEqual([10, 60, 300]);
    expect(MAX_ATTEMPTS).toBe(3);
  });
});
