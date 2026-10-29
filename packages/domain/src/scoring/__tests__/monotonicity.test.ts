/**
 * Properties the engine must never lose, whatever the calibration says later.
 * These are the four of the acceptance criteria, plus the trap of §7: a cheap
 * dossier whose window is closing must be able to outrank an expensive one.
 */
import { describe, it, expect } from 'vitest';
import { score } from '../score.ts';

const base = { amountCents: 12_400_00, weeksSinceSend: 2.7, signal: 0.49, annoyed: false };

describe('monotonicity', () => {
  it('a higher amount never lowers the score', () => {
    let previous = -1;
    for (const amount of [0, 1_000, 9_800, 45_000, 120_000, 900_000]) {
      const r = score({ ...base, amountCents: amount * 100 });
      expect(r.scoreCents).toBeGreaterThanOrEqual(previous);
      previous = r.scoreCents;
    }
  });

  it('a higher signal never lowers the score', () => {
    let previous = -1;
    for (const sig of [0.02, 0.2, 0.4, 0.6, 0.8, 0.98]) {
      const r = score({ ...base, signal: sig });
      expect(r.scoreCents).toBeGreaterThanOrEqual(previous);
      previous = r.scoreCents;
    }
  });

  it('urgency never increases once the window is passed (2.5 weeks)', () => {
    let previous = 1;
    for (const w of [2.5, 2.6, 3, 4, 5, 6, 8, 12]) {
      const r = score({ ...base, weeksSinceSend: w });
      expect(r.urgency).toBeLessThanOrEqual(previous);
      previous = r.urgency;
    }
  });

  it('an annoyed client always lowers p_reply, never the score of the same input', () => {
    for (const w of [0.2, 1, 2.7, 5, 7.9]) {
      for (const sig of [0.1, 0.3, 0.49, 0.7, 0.95]) {
        const calm = score({ ...base, weeksSinceSend: w, signal: sig });
        const annoyed = score({ ...base, weeksSinceSend: w, signal: sig, annoyed: true });
        expect(annoyed.pReply).toBeLessThan(calm.pReply);
      }
    }
  });

  it('a €2 000 dossier closing in 48 h outranks a €15 000 one with no urgency', () => {
    // The trap of §7: never filter on amount before scoring. The cheap dossier
    // is inside the optimal window (2.4 weeks) with a warm signal; the rich one
    // is at the edge of the window (6 weeks) and cold. Measured: 1 080 € vs 461 €.
    const cheapUrgent = score({ amountCents: 2_000_00, weeksSinceSend: 2.4, signal: 0.949, annoyed: false });
    const richStale = score({ amountCents: 15_000_00, weeksSinceSend: 6.0, signal: 0.102, annoyed: false });
    expect(cheapUrgent.urgency).toBe(1);
    expect(richStale.urgency).toBeLessThan(0.75);
    expect(cheapUrgent.scoreCents).toBeGreaterThan(richStale.scoreCents);
    // And the mirror image: at equal urgency and signal, the amount wins — the
    // ranking is not "cheap first", it is "value at risk first".
    const richFresh = score({ amountCents: 15_000_00, weeksSinceSend: 2.4, signal: 0.949, annoyed: false });
    expect(richFresh.scoreCents).toBeGreaterThan(cheapUrgent.scoreCents);
  });

  it('is deterministic to the cent', () => {
    const a = score({ ...base, context: { opens14d: 5, stage: 'negotiation' } });
    const b = score({ ...base, context: { opens14d: 5, stage: 'negotiation' } });
    expect(a).toEqual(b);
  });
});
