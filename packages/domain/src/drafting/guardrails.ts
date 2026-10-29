/**
 * The validator that runs after generation — and before a human ever sees the
 * text. Pure, no IO, no clock.
 *
 * Why so strict: a missing draft costs one manual message. A bad draft costs the
 * customer, because it is the message that leaves the building under their name.
 * The asymmetry justifies refusing anything doubtful.
 */
import type { PromptContext } from './context.ts';

export type ViolationCode =
  | 'forbidden_price'
  | 'forbidden_payment'
  | 'forbidden_discount'
  | 'forbidden_percentage'
  | 'forbidden_deadline'
  | 'forbidden_urgency'
  | 'forbidden_reminder'
  | 'forbidden_competitor'
  | 'commitment_date'
  | 'structure_question_count'
  | 'structure_no_greeting'
  | 'structure_no_signature'
  | 'length_out_of_range'
  | 'placeholder'
  | 'encoding_emoji'
  | 'encoding_exclamations'
  | 'encoding_long_word'
  | 'repetition'
  | 'empty_body';

export interface Violation {
  code: ViolationCode;
  /** Human-readable detail, used in the retry prompt and in the audit row. */
  detail: string;
}

export interface ValidatedDraft {
  subject: string;
  body: string;
}

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
  wordCount: number;
}

const MIN_WORDS = 60;
const MAX_WORDS = 140;
const MAX_TRIGRAM_OVERLAP = 0.6;

const PRICE = /\b(prix|price|tarifs?|rates?|coût|cost|honoraires)\b/i;
const PAYMENT = /\b(paiement|payment|virement|invoice|facture|facturation|acompte|échelonn\w*|iban|rib)\b/i;
const DISCOUNT = /\b(remise|réduction|discount|rabais|offre spéciale|promotion|gratuit\w*)\b/i;
const PERCENT = /(\d+\s*%|\bpour\s?cent\b|\bpercent\b)/i;
const DEADLINE = /\b(avant le|d'ici le|d’ici le|au plus tard|date limite|deadline|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
const URGENCY = /\b(urgent\w*|au plus vite|asap|immédiatement)\b/i;
const LAST_REMINDER = /\b(dernière relance|dernier rappel|final notice|last reminder)\b/i;
const PERMITS = /\b(je me permets de revenir|i take the liberty of coming back|je me permets de vous relancer)\b/i;
const COMPETITOR = /\b(concurrent\w*|competitor\w*|contrairement à|unlike|mieux que)\b/i;

const GREETING = /^(bonjour|bonsoir|madame|monsieur|hello|hi|dear|cher|chère)\b/i;
const SIGNATURE = /\b(bien à vous|cordialement|bien cordialement|bonne journée|belle journée|best regards|kind regards|regards|sincerely|à bientôt)\b/i;

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/**
 * A date written in the body that is not the send date of the dossier is a
 * commitment the model invented: "je vous rappelle le 12" is a promise nobody
 * made. Month names are matched, not numbers, so the required "sent on 6 October"
 * passes while "before 12 November" fails.
 */
const MONTHS_FR = ['janvier','février','fevrier','mars','avril','mai','juin','juillet','août','aout','septembre','octobre','novembre','décembre','decembre'];
const MONTHS_EN = ['january','february','march','april','may','june','july','august','september','october','november','december'];

export function validate(
  draft: ValidatedDraft,
  ctx: PromptContext,
  previousMessage?: string | null,
): ValidationResult {
  const violations: Violation[] = [];
  const body = (draft.body ?? '').trim();
  const subject = (draft.subject ?? '').trim();
  const all = `${subject}\n${body}`;

  if (body === '') {
    return { ok: false, violations: [{ code: 'empty_body', detail: 'corps vide' }], wordCount: 0 };
  }

  const push = (code: ViolationCode, detail: string) => violations.push({ code, detail });

  if (PRICE.test(all)) push('forbidden_price', match(all, PRICE));
  if (PAYMENT.test(all)) push('forbidden_payment', match(all, PAYMENT));
  if (DISCOUNT.test(all)) push('forbidden_discount', match(all, DISCOUNT));
  if (PERCENT.test(all)) push('forbidden_percentage', match(all, PERCENT));
  if (DEADLINE.test(all)) push('forbidden_deadline', match(all, DEADLINE));
  if (URGENCY.test(all)) push('forbidden_urgency', match(all, URGENCY));
  if (LAST_REMINDER.test(all)) push('forbidden_reminder', match(all, LAST_REMINDER));
  if (PERMITS.test(all)) push('forbidden_reminder', match(all, PERMITS));
  if (COMPETITOR.test(all)) push('forbidden_competitor', match(all, COMPETITOR));

  const strayDate = findStrayDate(body, ctx.sentDate);
  if (strayDate) push('commitment_date', strayDate);

  const questions = (body.match(/\?/g) ?? []).length;
  if (questions !== 1) push('structure_question_count', `${questions} point(s) d’interrogation`);

  if (!GREETING.test(firstLine(body))) push('structure_no_greeting', 'salutation absente');

  const tail = body.split('\n').slice(-4).join('\n');
  if (!SIGNATURE.test(tail)) push('structure_no_signature', 'formule de politesse absente');

  const wordCount = countWords(body);
  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) {
    push('length_out_of_range', `${wordCount} mots (attendu ${MIN_WORDS}–${MAX_WORDS})`);
  }

  if (/\{\{|\}\}|\[|\]|TODO|XXX|lorem ipsum/i.test(all)) push('placeholder', 'gabarit non rempli');
  if (EMOJI.test(all)) push('encoding_emoji', 'emoji détecté');
  const bangs = (body.match(/!/g) ?? []).length;
  if (bangs > 1) push('encoding_exclamations', `${bangs} points d’exclamation`);
  const longWord = (all.match(/\S{41,}/g) ?? [])[0];
  if (longWord) push('encoding_long_word', longWord.slice(0, 40));

  if (previousMessage && overlap(body, previousMessage) > MAX_TRIGRAM_OVERLAP) {
    push('repetition', `${Math.round(overlap(body, previousMessage) * 100)} % de trigrammes communs`);
  }

  return { ok: violations.length === 0, violations, wordCount };
}

function match(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? `« ${m[0]} »` : '';
}

function firstLine(body: string): string {
  return (body.split('\n').find((l) => l.trim() !== '') ?? '').trim();
}

export function countWords(body: string): number {
  return body
    .replace(/[^\p{L}\p{N}\s’'-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

function findStrayDate(body: string, sentDate: string): string | null {
  const sent = sentDate.toLowerCase();
  for (const month of [...MONTHS_FR, ...MONTHS_EN]) {
    const re = new RegExp(`\\b(\\d{1,2})\\s+(${month})\\b`, 'gi');
    for (const m of body.matchAll(re)) {
      const phrase = m[0].toLowerCase();
      // The send date of the dossier is required by §8.2: it is not a promise.
      if (sent.includes(phrase)) continue;
      return `date inventée : « ${phrase} »`;
    }
  }
  return null;
}

/** Jaccard over word trigrams: cheap, order-sensitive enough, and explainable. */
export function overlap(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

function trigrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i += 1) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

/** Stable, sorted list of codes — this is what gets persisted and shown. */
export function violationCodes(violations: readonly Violation[]): string[] {
  return [...new Set(violations.map((v) => v.code))].sort();
}
