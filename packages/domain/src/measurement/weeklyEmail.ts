/**
 * The weekly email. Three lines, no chart, no engagement bait.
 *
 * What happened · what it is worth · what to do today. If the sentence that
 * describes the value has to say "pas encore concluant", it says it — an email
 * that oversells the week is the fastest way to lose the argument in month four.
 */
import type { Locale } from './headline.ts';

export interface WeeklyEmailInput {
  workspaceName: string;
  locale: Locale;
  weekStart: string;
  nReplies: number;
  nWon: number;
  revenueCents: number;
  headline: string;
  queueSize: number;
  /** Share of the pipeline the holdout represents, for the reminder line. */
  holdoutCount: number;
}

const money = (cents: number, locale: Locale) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(cents / 100);

export function renderWeeklyEmail(input: WeeklyEmailInput): { subject: string; text: string } {
  const fr = input.locale === 'fr';
  const subject = fr
    ? `Votre semaine : ${input.nReplies} réponse${input.nReplies > 1 ? 's' : ''}, ${input.nWon} affaire${input.nWon > 1 ? 's' : ''} signée${input.nWon > 1 ? 's' : ''}`
    : `Your week: ${input.nReplies} repl${input.nReplies === 1 ? 'y' : 'ies'}, ${input.nWon} deal${input.nWon > 1 ? 's' : ''} won`;

  const line1 = fr
    ? `${input.nReplies} réponse${input.nReplies > 1 ? 's' : ''} reçue${input.nReplies > 1 ? 's' : ''}, ${input.nWon} affaire${input.nWon > 1 ? 's' : ''} signée${input.nWon > 1 ? 's' : ''} (${money(input.revenueCents, input.locale)} sur les dossiers relancés).`
    : `${input.nReplies} repl${input.nReplies === 1 ? 'y' : 'ies'} received, ${input.nWon} deal${input.nWon > 1 ? 's' : ''} won (${money(input.revenueCents, input.locale)} on followed-up dossiers).`;

  const line2 = input.headline;

  const line3 = fr
    ? `${input.queueSize} dossier${input.queueSize > 1 ? 's' : ''} dans la file aujourd’hui · ${input.holdoutCount} dossier${input.holdoutCount > 1 ? 's' : ''} du groupe témoin ne recevront rien, c’est ce qui rend le chiffre défendable.`
    : `${input.queueSize} dossier${input.queueSize > 1 ? 's' : ''} in today's queue · ${input.holdoutCount} control dossiers will receive nothing, which is what makes the number defensible.`;

  return {
    subject,
    // Plain text on purpose: this email is read on a phone in a lift.
    text: `${line1}\n\n${line2}\n\n${line3}\n\n— ${input.workspaceName}\n`,
  };
}
