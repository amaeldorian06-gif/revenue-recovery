/**
 * The headline sentence — the only sentence most users will read.
 *
 * Three states, and the one that says "we cannot prove anything" is written with
 * the most care, because it is the one that costs us a sale and the one that makes
 * the product honest. It is generated from data, never hand-written per customer,
 * and it is snapshot-tested: the words "rapporté", "gagné" and "récupéré" are
 * forbidden unless there is a significant positive interval to back them.
 */
import type { AttributionResult } from './attribution.ts';

export type HeadlineState = 'insufficient_data' | 'no_effect' | 'effect';
export type Locale = 'fr' | 'en';

/** Below this, a bootstrap interval is not an interval, it is a rumour. */
export const MIN_PER_ARM = 30;

export interface HeadlineInput {
  levelA: Pick<AttributionResult['levelA'], 'estimateCents' | 'ciLow' | 'ciHigh' | 'significant' | 'nTreatment' | 'nHoldout'>;
  requiredSample: AttributionResult['requiredSample'];
  /** Weeks of history available for the experiment. */
  weeksMeasured: number;
}

export function headlineState(input: HeadlineInput): HeadlineState {
  const { nTreatment, nHoldout, significant, estimateCents } = input.levelA;
  if (nHoldout < MIN_PER_ARM || nTreatment < MIN_PER_ARM) return 'insufficient_data';
  if (significant && estimateCents > 0) return 'effect';
  return 'no_effect';
}

const money = (cents: number, locale: Locale) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(cents / 100);

/** Weeks still needed, from the required sample per arm and the current pace. */
export function weeksNeeded(input: HeadlineInput): number {
  const required = input.requiredSample;
  if (!required) return 12;
  const missing = Math.max(0, required.perArm - required.currentPerArm);
  const perWeek = input.weeksMeasured > 0 ? required.currentPerArm / input.weeksMeasured : 0;
  // No pace yet (first week): fall back to a 12-week horizon rather than "∞".
  if (perWeek <= 0) return Math.max(1, Math.ceil(missing / 8));
  return Math.max(1, Math.ceil(missing / perWeek));
}

export interface Headline {
  state: HeadlineState;
  text: string;
}

export function headline(input: HeadlineInput, locale: Locale = 'fr'): Headline {
  const state = headlineState(input);
  const { nTreatment, nHoldout, ciLow, ciHigh } = input.levelA;
  const weeks = weeksNeeded(input);

  if (state === 'insufficient_data') {
    return {
      state,
      text:
        locale === 'fr'
          ? `Il faut encore environ ${weeks} semaine${weeks > 1 ? 's' : ''} de dossiers pour conclure. Aujourd’hui : ${fmtInt(nTreatment, locale)} dossiers traités, ${fmtInt(nHoldout, locale)} témoins.`
          : `About ${weeks} more week${weeks > 1 ? 's' : ''} of dossiers are needed to conclude. Today: ${fmtInt(nTreatment, locale)} treated dossiers, ${fmtInt(nHoldout, locale)} controls.`,
    };
  }

  if (state === 'no_effect') {
    const low = money(ciLow, locale);
    const high = money(ciHigh, locale);
    return {
      state,
      text:
        locale === 'fr'
          ? `À ce stade, nous ne pouvons pas démontrer de gain. L’intervalle de confiance va de ${low} à ${high}. Nous continuons de mesurer.`
          : `At this stage we cannot demonstrate a gain. The confidence interval runs from ${low} to ${high}. We keep measuring.`,
    };
  }

  const months = Math.max(1, Math.round((input.weeksMeasured * 7) / 30.4));
  return {
    state,
    text:
      locale === 'fr'
        ? `Sur les ${months} derniers mois, le produit a rapporté ${money(ciLow, locale)} à ${money(ciHigh, locale)}, avec 95 % de confiance.`
        : `Over the last ${months} months, the product generated ${money(ciLow, locale)} to ${money(ciHigh, locale)}, with 95 % confidence.`,
  };
}

const fmtInt = (n: number, locale: Locale) => new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB').format(n);
