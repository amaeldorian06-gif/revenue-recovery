/**
 * Criterion 8: every card's "why now" sentence is non-empty, contains at least
 * one number, and fits in 120 characters. GV-2's three factor sentences are
 * frozen here — if the wording changes, the snapshot must be updated on purpose.
 */
import { describe, it, expect } from 'vitest';
import { score } from '../score.ts';
import { whyNow, topSentences, formulaLines, priorityIndex, sentences } from '../explanations.ts';

const GV2 = score({
  amountCents: 12_400_00,
  weeksSinceSend: 2.7,
  signal: 0.49,
  annoyed: false,
  context: { opens14d: 5, stage: 'proposal_sent', stageScore: 0.35, replyHistoryRate: 0.7 },
});

describe('why now', () => {
  it('is non-empty and contains a number, for every golden vector', () => {
    const vectors = [
      [45_000_00, 4.7, 0.6], [12_400_00, 2.7, 0.49], [2_100_00, 1.7, 0.4],
      [18_300_00, 7.9, 0.3], [14_800_00, 0.4, 0.55], [9_800_00, 1.0, 0.5],
    ] as const;
    for (const [amount, weeks, sig] of vectors) {
      const r = score({ amountCents: amount, weeksSinceSend: weeks, signal: sig, annoyed: false });
      for (const locale of ['fr', 'en'] as const) {
        const line = whyNow(r.factors, locale);
        expect(line.length).toBeGreaterThan(0);
        expect(line).toMatch(/\d/);
        expect(line.length).toBeLessThanOrEqual(120);
      }
    }
  });

  it('freezes the three sentences of GV-2 (FR and EN)', () => {
    expect(topSentences(GV2.factors, 'fr')).toEqual([
      'ouvert 5 fois ces 14 derniers jours',
      'répond 70 % du temps d\'habitude',
      'stade à 35 % de maturité',
    ]);
    expect(topSentences(GV2.factors, 'en')).toEqual([
      'opened 5 times in the last 14 days',
      'replies 70 % of the time',
      'stage at 35 % maturity',
    ]);
  });

  it('never accuses a client of answering 0 % of the time', () => {
    const fresh = score({
      amountCents: 10_000_00, weeksSinceSend: 2, signal: 0.4, annoyed: false,
      context: { replyHistoryRate: 0, stage: 'proposal_sent', stageScore: 0.35 },
    });
    expect(sentences(fresh.factors, 'fr').join(' ')).not.toContain('0 %');
  });

  it('shows the multiplication with the real numbers', () => {
    const [expected, priority] = formulaLines(
      { amountCents: 12_400_00, pReply: GV2.pReply, pConvert: GV2.pConvert, urgency: GV2.urgency, expectedValueCents: GV2.expectedValueCents },
      100,
      'fr',
    );
    // French formatting groups thousands with U+202F (narrow no-break space),
    // not with a plain space: asserted explicitly so a "cleanup" that replaces
    // it breaks here rather than in a screenshot.
    const NB = '\u202f';
    // Le symbole € est precedé d'une espace insécable ordinaire (U+00A0) par Intl,
    // tandis que les milliers sont séparés par U+202F : les deux sont assertés.
    const NBSP = '\u00a0';
    expect(expected).toBe(`valeur attendue = 12${NB}400${NBSP}€ × 41,2 % × 64,4 % = 3${NB}293${NBSP}€`);
    expect(priority).toBe('priorité = valeur attendue × urgence 0,98 = 100/100');
  });

  it('computes a priority index relative to the best score of the day', () => {
    expect(priorityIndex(9_209_00, 9_209_00)).toBe(100);
    expect(priorityIndex(3_228_00, 9_209_00)).toBe(35);
    expect(priorityIndex(0, 0)).toBe(0);
  });
});
