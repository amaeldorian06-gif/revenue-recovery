/**
 * Opportunity → PromptContext. Structured, typed, explicit.
 *
 * Two rules that this file exists to enforce:
 *   • it never reads a mailbox. Phase 07 draws the privacy boundary; this phase
 *     must not preempt it by stuffing a thread into a prompt "to improve quality".
 *     Only the last two messages, already produced by us, truncated to 400 chars.
 *   • when there is nothing specific to say, it refuses to draft. A generic
 *     follow-up burns the contact: the next attempt has no new reason to exist.
 */

export type Locale = 'fr' | 'en';
export type Tone = 'warm' | 'direct' | 'formal';

export interface ContextOpportunity {
  clientName: string;
  title: string | null;
  amountCents: number;
  sentAt: Date;
  stage: string;
  touchCount: number;
  lastTouchAt: Date | null;
  contextNote: string | null;
}

export interface ContextContact {
  firstName: string | null;
  email: string | null;
  locale: Locale | null;
}

export interface PromptContext {
  locale: Locale;
  tone: Tone;
  contactFirstName: string | null;
  clientName: string;
  amount: string;
  sentDate: string;
  title: string;
  stage: string;
  touchNumber: number;
  daysSinceSend: number;
  lastTouchDays: number | null;
  contextNote: string;
  previousMessages: string[];
  /** Name used in the signature; the founder's, not the software's. */
  senderName: string;
}

export type ContextFailure = 'insufficient_context';

export interface BuildContextInput {
  opportunity: ContextOpportunity;
  contact?: ContextContact | null;
  previousMessages?: readonly string[];
  tone?: Tone;
  locale?: Locale;
  senderName?: string;
  now: Date;
}

export type ContextResult =
  | { ok: true; value: PromptContext }
  | { ok: false; reason: ContextFailure };

const TRUNCATE = 400;
const DAY = 86_400_000;

const formatAmount = (cents: number, locale: Locale) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(cents / 100);

const formatDate = (d: Date, locale: Locale) =>
  new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);

export function buildContext(input: BuildContextInput): ContextResult {
  const { opportunity: o, contact, now } = input;
  const locale = contact?.locale ?? input.locale ?? 'fr';

  const title = (o.title ?? '').trim();
  const note = (o.contextNote ?? '').trim();

  // No object and no note = nothing specific to say. See the module comment.
  if (title === '' && note === '') return { ok: false, reason: 'insufficient_context' };

  const daysSinceSend = Math.max(0, Math.floor((now.getTime() - o.sentAt.getTime()) / DAY));
  const lastTouchDays = o.lastTouchAt
    ? Math.max(0, Math.floor((now.getTime() - o.lastTouchAt.getTime()) / DAY))
    : null;

  return {
    ok: true,
    value: {
      locale,
      tone: input.tone ?? 'warm',
      contactFirstName: clean(contact?.firstName ?? null),
      clientName: o.clientName,
      amount: formatAmount(o.amountCents, locale),
      sentDate: formatDate(o.sentAt, locale),
      title: title || note.slice(0, 80),
      stage: o.stage,
      touchNumber: o.touchCount + 1,
      daysSinceSend,
      lastTouchDays,
      contextNote: note,
      previousMessages: (input.previousMessages ?? [])
        .slice(-2)
        .map((m) => m.slice(0, TRUNCATE)),
      senderName: input.senderName ?? 'L’équipe',
    },
  };
}

function clean(v: string | null): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}
