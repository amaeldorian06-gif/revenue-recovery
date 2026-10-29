/**
 * Factors → one sentence a human can say out loud.
 *
 * The test of this module is the master prompt's own test (§7.4): a user must be
 * able to explain why row 1 is first. So every sentence carries a number, and
 * the "why now" line is capped at 120 characters — a sentence that needs more
 * room than that is not an explanation, it is a paragraph nobody reads.
 */
import type { Factor, FactorKey } from './score.ts';

export type Locale = 'fr' | 'en';

const euros = (cents: number, locale: Locale) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(cents / 100);

const DAYS = (weeks: number) => Math.max(0, Math.round(weeks * 7));

const TEMPLATES: Record<FactorKey, Record<Locale, (f: Factor, locale: Locale) => string>> = {
  opens: {
    fr: (f) => `ouvert ${f.value} fois ces 14 derniers jours`,
    en: (f) => `opened ${f.value} times in the last 14 days`,
  },
  reply_history: {
    fr: (f) => `répond ${Math.round(f.value * 100)} % du temps d'habitude`,
    en: (f) => `replies ${Math.round(f.value * 100)} % of the time`,
  },
  stage_strength: {
    fr: (f) => `stade à ${Math.round(f.value * 100)} % de maturité`,
    en: (f) => `stage at ${Math.round(f.value * 100)} % maturity`,
  },
  silence_weeks: {
    fr: (f) => `aucun contact depuis ${DAYS(f.value)} jours`,
    en: (f) => `no contact for ${DAYS(f.value)} days`,
  },
  window_closing: {
    fr: (f) => `fenêtre optimale dépassée de ${f.value} jours`,
    en: (f) => `optimal window passed ${f.value} days ago`,
  },
  value: {
    fr: (f, locale) => `montant en jeu : ${euros(f.value, locale)}`,
    en: (f, locale) => `${euros(f.value, locale)} at stake`,
  },
};

/** One sentence per factor, in the order the engine produced them. */
export function sentences(factors: readonly Factor[], locale: Locale): string[] {
  return factors.map((f) => TEMPLATES[f.key][locale](f, locale));
}

/**
 * The "why now" line: at most 120 characters, ended on a whole clause. When the
 * first clause alone is long enough we stop there rather than truncate mid-word.
 */
export function whyNow(factors: readonly Factor[], locale: Locale, maxChars = 120): string {
  const parts: string[] = [];
  let length = 0;
  const sep = locale === 'fr' ? ' · ' : ' · ';

  for (const f of factors) {
    const s = TEMPLATES[f.key][locale](f, locale);
    const next = length === 0 ? s.length : length + sep.length + s.length;
    if (next > maxChars && parts.length > 0) break;
    parts.push(s);
    length = next;
    if (parts.length === 3) break;
  }
  return parts.join(sep);
}

/** At most three factor sentences, as §7.4 requires. */
export function topSentences(factors: readonly Factor[], locale: Locale): string[] {
  return sentences(factors.slice(0, 3), locale);
}

/**
 * The monospace block of the expanded card. It shows the actual multiplication
 * with the actual numbers, so the priority cannot be mistaken for a promise.
 */
export function formulaLines(
  input: { amountCents: number; pReply: number; pConvert: number; urgency: number; expectedValueCents: number },
  priority: number,
  locale: Locale,
): [string, string] {
  const amount = euros(input.amountCents, locale);
  const expected = euros(input.expectedValueCents, locale);
  const pr = `${(input.pReply * 100).toFixed(1).replace('.', locale === 'fr' ? ',' : '.')} %`;
  const pc = `${(input.pConvert * 100).toFixed(1).replace('.', locale === 'fr' ? ',' : '.')} %`;
  const ur = input.urgency.toFixed(2).replace('.', locale === 'fr' ? ',' : '.');

  return locale === 'fr'
    ? [
        `valeur attendue = ${amount} × ${pr} × ${pc} = ${expected}`,
        `priorité = valeur attendue × urgence ${ur} = ${priority}/100`,
      ]
    : [
        `expected value = ${amount} × ${pr} × ${pc} = ${expected}`,
        `priority = expected value × urgency ${ur} = ${priority}/100`,
      ];
}

/** 0–100, relative to the best score of the workspace. A rank, never a promise. */
export function priorityIndex(scoreCents: number, maxScoreCents: number): number {
  if (!Number.isFinite(scoreCents) || maxScoreCents <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((100 * scoreCents) / maxScoreCents)));
}
