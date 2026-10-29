import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures — the `t=<ts>,v1=<hmac>` scheme of the phase prompt,
 * HMAC-SHA256 over `timestamp.body`, 5-minute tolerance, replay-safe.
 */
const TOLERANCE_MS = 5 * 60 * 1000;

export function signPayload(secret: string, body: string, timestamp: number = Date.now()): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export interface VerifyResult {
  ok: boolean;
  reason?: 'malformed' | 'tolerance' | 'signature';
}

export function verifySignature(header: string, secret: string, body: string, now: number = Date.now()): VerifyResult {
  const parts = new Map<string, string>();
  for (const piece of header.split(',')) {
    const [k, v] = piece.split('=');
    if (!k || v === undefined) return { ok: false, reason: 'malformed' };
    parts.set(k.trim(), v.trim());
  }
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'malformed' };
  if (Math.abs(now - t) > TOLERANCE_MS) return { ok: false, reason: 'tolerance' };
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(v1, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'signature' };
  return { ok: true };
}

/** Backoff schedule for failed deliveries: 10 s, 60 s, 300 s, then dead-letter. */
export const RETRY_DELAYS_S = [10, 60, 300] as const;
export const MAX_ATTEMPTS = 3;
/** An endpoint failing 20 times in a row is disabled outright. */
export const DISABLE_AFTER_CONSECUTIVE = 20;
