/**
 * Prompt template v1 — the version is written on every action it produces.
 *
 * When the wording changes, PROMPT_VERSION changes with it: a draft generated in
 * March must stay explainable in September, and "the template changed" is a
 * legitimate answer only if the version proves it.
 *
 * The order of the blocks is normative (phase 04, §"Prompt template"): identity,
 * commercial constraint, structure, length and tone, prohibitions, output
 * contract. Reordering them changes behaviour more than editing the words does,
 * because a model weights the last instruction most.
 */
import type { PromptContext } from '../context.ts';

export const PROMPT_VERSION = 'v1';

const PROHIBITIONS_FR = `INTERDIT, sans exception :
- tout prix, remise, pourcentage, condition de paiement ou référence de facture ;
- toute échéance ou promesse de livraison absente du dossier ;
- les emojis, les points d'exclamation, « urgent », « dernière relance », « je me permets de revenir vers vous » ;
- plus d'une question ;
- toute affirmation sur un concurrent ;
- tout champ non rempli ({{, }}, [, TODO, XXX) ;
- tout mot de plus de 40 caractères.`;

const PROHIBITIONS_EN = `FORBIDDEN, without exception:
- any price, discount, percentage, payment term or invoice reference;
- any deadline or delivery promise absent from the dossier;
- emojis, exclamation marks, "urgent", "last reminder", "I take the liberty of coming back to you";
- more than one question;
- any claim about a competitor;
- any unfilled placeholder ({{, }}, [, TODO, XXX);
- any word longer than 40 characters.`;

export function systemPrompt(ctx: PromptContext): string {
  if (ctx.locale === 'en') {
    return [
      'You write a single follow-up email for a small agency, on behalf of the founder.',
      '',
      'Commercial constraint: you never mention price, discount, deadline, payment terms,',
      'and you never make any commitment. The amount below is a reference, not an offer.',
      '',
      'Structure, in this order: a greeting, one specific reference to the proposal',
      '(date AND object or amount), one piece of concrete context, ONE single question,',
      'an easy exit, then a signature.',
      '',
      `Length: 60 to 140 words. Tone: ${ctx.tone}.`,
      '',
      PROHIBITIONS_EN,
      '',
      'Output contract: strict JSON {"subject": "...", "body": "..."} and nothing else.',
      'No markdown, no commentary, no code fence.',
    ].join('\n');
  }

  return [
    'Vous écrivez un seul e-mail de relance pour une petite agence, au nom du fondateur.',
    '',
    'Contrainte commerciale : vous ne mentionnez jamais de prix, de remise, d’échéance ni',
    'de condition de paiement, et vous ne prenez aucun engagement. Le montant ci-dessous',
    'est une référence, pas une offre.',
    '',
    'Structure, dans cet ordre : une salutation, une référence précise à la proposition',
    '(date ET objet ou montant), un élément de contexte concret, UNE seule question,',
    'une porte de sortie facile, puis une signature.',
    '',
    `Longueur : 60 à 140 mots. Ton : ${ctx.tone}.`,
    '',
    PROHIBITIONS_FR,
    '',
    'Contrat de sortie : JSON strict {"subject": "...", "body": "..."} et rien d’autre.',
    'Pas de markdown, pas de commentaire, pas de balise de code.',
  ].join('\n');
}

export function userPrompt(ctx: PromptContext): string {
  const facts = [
    `locale: ${ctx.locale}`,
    `client: ${ctx.clientName}`,
    `contact_first_name: ${ctx.contactFirstName ?? '(inconnu)'}`,
    `amount: ${ctx.amount}`,
    `sent_date: ${ctx.sentDate}`,
    `title: ${ctx.title}`,
    `stage: ${ctx.stage}`,
    `touch_number: ${ctx.touchNumber}`,
    `days_since_send: ${ctx.daysSinceSend}`,
    `last_touch_days: ${ctx.lastTouchDays ?? 'n/a'}`,
    `context_note: ${ctx.contextNote || '(none)'}`,
    `sender_name: ${ctx.senderName}`,
  ].join('\n');

  const previous = ctx.previousMessages.length
    ? `\n\nMESSAGES PRÉCÉDENTS (ne pas répéter, ne pas citer) :\n${ctx.previousMessages
        .map((m, i) => `--- ${i + 1} ---\n${m}`)
        .join('\n')}`
    : '';

  return `FICHE DU DOSSIER\n${facts}${previous}`;
}

/**
 * Appended to the user prompt for the single authorised retry. The model is told
 * exactly what it broke — "try again" produces the same mistake with new words.
 */
export function violationPrompt(codes: readonly string[], locale: PromptContext['locale']): string {
  const list = codes.join(', ');
  return locale === 'en'
    ? `\n\nYour previous draft was rejected by the validator. Violations: ${list}. Write a new draft that fixes every one of them.`
    : `\n\nVotre brouillon précédent a été rejeté par le validateur. Violations : ${list}. Écrivez un nouveau brouillon qui corrige chacune d’elles.`;
}
