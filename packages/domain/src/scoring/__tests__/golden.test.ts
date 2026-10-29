/**
 * The regression firewall of §7.3.
 *
 * If this file fails after someone touched a constant in score.ts, the formula
 * was "improved" — not fixed. The golden vectors come from the calibration
 * simulation of the product (150 replications, 12 months), they are not
 * arbitrary: changing them invalidates every number shown to a customer.
 */
import { describe, it, expect } from 'vitest';
import { score, ENGINE_VERSION } from '../score.ts';
import { signal } from '../signals.ts';

interface Golden {
  id: string;
  amount: number;
  weeks: number;
  signal: number;
  annoyed: boolean;
  pReply: number;
  pConvert: number;
  expected: number;
  urgency: number;
  score: number;
}

const GOLDEN: Golden[] = [
  { id: 'GV-1', amount: 45_000, weeks: 4.7, signal: 0.6, annoyed: false, pReply: 0.3592, pConvert: 0.71, expected: 11_476, urgency: 0.8025, score: 9_209 },
  { id: 'GV-2', amount: 12_400, weeks: 2.7, signal: 0.49, annoyed: false, pReply: 0.4124, pConvert: 0.644, expected: 3_293, urgency: 0.9802, score: 3_228 },
  { id: 'GV-3', amount: 2_100, weeks: 1.7, signal: 0.4, annoyed: false, pReply: 0.4226, pConvert: 0.59, expected: 524, urgency: 1, score: 524 },
  { id: 'GV-4', amount: 18_300, weeks: 7.9, signal: 0.3, annoyed: true, pReply: 0.0491, pConvert: 0.53, expected: 476, urgency: 0.5827, score: 277 },
  { id: 'GV-5', amount: 14_800, weeks: 0.4, signal: 0.55, annoyed: false, pReply: 0.501, pConvert: 0.68, expected: 5_042, urgency: 0.73, score: 3_681 },
  { id: 'GV-6', amount: 9_800, weeks: 1.0, signal: 0.5, annoyed: false, pReply: 0.5039, pConvert: 0.65, expected: 3_210, urgency: 1, score: 3_210 },
];

const FAIL_HINT =
  'Un vecteur d\'or ne correspond plus. La formule de §7.2 a été modifiée : ' +
  'ne mettez pas à jour cette attente, rétablissez la formule (les chiffres ' +
  'montrés au client en dépendent).';

describe('golden vectors §7.3', () => {
  for (const g of GOLDEN) {
    it(`${g.id} reproduit p_reply, p_conv, valeur attendue et score`, () => {
      const r = score({
        amountCents: g.amount * 100,
        weeksSinceSend: g.weeks,
        signal: g.signal,
        annoyed: g.annoyed,
      });
      expect(Math.abs(r.pReply - g.pReply), FAIL_HINT).toBeLessThanOrEqual(0.0005);
      expect(Math.abs(r.pConvert - g.pConvert), FAIL_HINT).toBeLessThanOrEqual(0.0005);
      expect(Math.abs(r.expectedValueCents / 100 - g.expected), FAIL_HINT).toBeLessThanOrEqual(1);
      expect(Math.abs(r.urgency - g.urgency), FAIL_HINT).toBeLessThanOrEqual(0.0005);
      expect(Math.abs(r.scoreCents / 100 - g.score), FAIL_HINT).toBeLessThanOrEqual(1);
    });
  }

  it('stores the engine version on every result', () => {
    const r = score({ amountCents: 100_00, weeksSinceSend: 1, signal: 0.5, annoyed: false });
    expect(r.engineVersion).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toBe('2026-10-v1');
  });
});

describe('signal §7.1', () => {
  it('opens=3, reply_rate=0.70, won=2, proposal_sent → 0.493 ± 0.001', () => {
    const s = signal({ opens14d: 3, replyHistoryRate: 0.7, wonDealsWithClient: 2, stage: 'proposal_sent' });
    expect(Math.abs(s.value - 0.493)).toBeLessThanOrEqual(0.001);
  });

  it('documents the range the signal can actually take: 0.102 to 0.949', () => {
    // Both clamps of §7.1 ([0.02, 0.98]) are guards for a future stage table,
    // not active constraints: with today's weights and stages the worst dossier
    // is 0.34 × 0.30 = 0.102 and the best is 0.30 + 0.22 + 0.14 + 0.34 × 0.85 =
    // 0.949. Written down so nobody "fixes" a clamp that never fires.
    const worst = signal({ opens14d: 0, replyHistoryRate: 0, wonDealsWithClient: 0, stage: 'followup_3' });
    const best = signal({ opens14d: 40, replyHistoryRate: 1, wonDealsWithClient: 9, stage: 'verbal_yes' });
    expect(worst.value).toBeCloseTo(0.102, 6);
    expect(best.value).toBeCloseTo(0.949, 6);
    expect(worst.clamped || best.clamped).toBe(false);
  });

  it('uses 0.35 when the reply history is unknown, and 0 opens when unobserved', () => {
    const s = signal({ stage: 'proposal_sent' });
    // 0 + 0.22×0.35 + 0 + 0.34×0.35 = 0.196
    expect(Math.abs(s.value - 0.196)).toBeLessThanOrEqual(0.0005);
  });
});
