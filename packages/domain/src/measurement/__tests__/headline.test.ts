/**
 * Criterion 3 — small-sample honesty, enforced on the rendered string.
 *
 * The forbidden words are the point: "rapporté", "gagné", "récupéré" describe a
 * result. With eight holdout dossiers there is no result, and the sentence must
 * say so even if the numbers happen to look good.
 */
import { describe, it, expect } from 'vitest';
import { headline, headlineState, weeksNeeded, type HeadlineInput } from '../headline.ts';

/** French typography uses narrow no-break spaces; assertions should not depend on them. */
const flat = (s: string) => s.replace(/[\u00a0\u202f\u2009]/g, ' ');

const FORBIDDEN = /rapport[ée]|gagn[ée]|r[ée]cup[ée]r/i;

function input(
  over: Partial<Omit<HeadlineInput, 'levelA'>> & { levelA?: Partial<HeadlineInput['levelA']> },
): HeadlineInput {
  const base: HeadlineInput = {
    levelA: {
      estimateCents: 0, ciLow: -810_000, ciHigh: 2_900_000,
      significant: false, nTreatment: 34, nHoldout: 8,
    },
    requiredSample: { perArm: 120, currentPerArm: 8, progressPct: 7 },
    weeksMeasured: 1,
  };
  return { ...base, ...over, levelA: { ...base.levelA, ...(over.levelA ?? {}) } };
}

describe('3. small-sample honesty', () => {
  it('says "not enough data" with 8 holdout dossiers, and never uses a result word', () => {
    const h = headline(input({ levelA: { nHoldout: 8, nTreatment: 26 } }), 'fr');

    expect(h.state).toBe('insufficient_data');
    expect(flat(h.text)).toMatch(/^Il faut encore environ \d+ semaines? de dossiers pour conclure\. Aujourd’hui : 26 dossiers traités, 8 témoins\.$/);
    expect(flat(h.text)).not.toMatch(FORBIDDEN);
    expect(flat(h.text)).not.toContain('€');
  });

  it('snapshots the rendered sentence for the three states', () => {
    const texts = {
      insufficient: flat(headline(input({ levelA: { nHoldout: 8, nTreatment: 26 } }), 'fr').text),
      noEffect: flat(
        headline(
          input({ levelA: { nHoldout: 210, nTreatment: 840, ciLow: -810_000, ciHigh: 2_900_000, significant: false } }),
          'fr',
        ).text,
      ),
      effect: flat(
        headline(
          input({
            levelA: { nHoldout: 210, nTreatment: 840, ciLow: 4_850_000, ciHigh: 8_730_000, significant: true, estimateCents: 6_700_000 },
            requiredSample: { perArm: 40, currentPerArm: 210, progressPct: 100 },
            weeksMeasured: 52,
          }),
          'fr',
        ).text,
      ),
    };

    expect(texts).toEqual({
      // 8 holdout dossiers in the first week, 120 needed per arm → 14 weeks of
      // patience. The sentence states the horizon instead of the fantasy.
      insufficient: 'Il faut encore environ 14 semaines de dossiers pour conclure. Aujourd’hui : 26 dossiers traités, 8 témoins.',
      noEffect:
        'À ce stade, nous ne pouvons pas démontrer de gain. L’intervalle de confiance va de -8 100 € à 29 000 €. Nous continuons de mesurer.',
      effect: 'Sur les 12 derniers mois, le produit a rapporté 48 500 € à 87 300 €, avec 95 % de confiance.',
    });

    // Only the third variant is allowed to claim anything.
    expect(texts.insufficient).not.toMatch(FORBIDDEN);
    expect(texts.noEffect).not.toMatch(FORBIDDEN);
    expect(texts.effect).toMatch(FORBIDDEN);
  });

  it('never says "effect" while the interval still crosses zero', () => {
    const h = headline(
      input({ levelA: { nHoldout: 200, nTreatment: 800, ciLow: -100_000, ciHigh: 150_000, significant: false } }),
      'fr',
    );
    expect(h.state).toBe('no_effect');
    expect(flat(h.text)).toContain('ne pouvons pas démontrer de gain');
  });

  it('needs a minimum per arm, whatever the interval says', () => {
    expect(
      headlineState(input({ levelA: { nHoldout: 29, nTreatment: 4000, significant: true, estimateCents: 900_000 } })),
    ).toBe('insufficient_data');
  });

  it('asks for a horizon in weeks, not for a number it cannot compute', () => {
    expect(weeksNeeded(input({ requiredSample: { perArm: 120, currentPerArm: 40, progressPct: 33 }, weeksMeasured: 4 }))).toBe(8);
    expect(weeksNeeded(input({ requiredSample: null }))).toBe(12);
  });

  it('speaks English when the workspace does', () => {
    const h = headline(input({ levelA: { nHoldout: 8, nTreatment: 26 } }), 'en');
    expect(h.state).toBe('insufficient_data');
    expect(h.text).toMatch(/About \d+ more weeks? of dossiers/);
    expect(h.text).not.toMatch(/rapport|récup/i);
  });
});
