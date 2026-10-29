/**
 * The seven gates of §6.4 — independent predicates, each returning a named
 * reason. Independence is the point: the empty state of the queue must be able
 * to say *why* nothing is left ("12 en attente de délai · 4 en groupe témoin"),
 * which is impossible if the gates are welded into one boolean.
 *
 * Business days are counted on the workspace calendar: a proposal sent on Friday
 * is five business days old on the following Friday, not on Wednesday.
 */

export type RejectionCode =
  | 'HOLDOUT'
  | 'NOT_OPEN'
  | 'TOUCH_LIMIT'
  | 'TOO_SOON'
  | 'RECENT_TOUCH'
  | 'REPLIED'
  | 'OPTED_OUT'
  | 'WINDOW_CLOSED';

export const GATES = {
  /** Gate 1 — the control group receives nothing, by construction. */
  HOLDOUT_ARM: 'holdout',
  /** Gate 3 — a fourth message is harassment, not recovery. */
  MAX_TOUCHES: 3,
  /** Gate 4 — first touch, in business days. */
  MIN_BUSINESS_DAYS: 5,
  /** Gate 5 — between two touches, in calendar days. */
  MIN_DAYS_BETWEEN_TOUCHES: 7,
  /** Gate 7 — after six weeks the window is closed. */
  MAX_WEEKS: 6,
} as const;

export interface EligibilityInput {
  arm: 'treatment' | 'holdout';
  status: string;
  touchCount: number;
  sentAt: Date | string;
  lastTouchAt: Date | string | null;
  replyReceivedAt: Date | string | null;
  contactOptedOut?: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Empty when eligible; exactly one code when not. */
  code?: RejectionCode;
  /** Values that produced the decision, for the explanation and the tests. */
  detail: {
    businessDaysSinceSend: number;
    /** Measured from the send date when `lastTouchAt` is unknown. */
    daysSinceLastTouch: number | null;
    weeksSinceSend: number;
    lastTouchKnown: boolean;
  };
}

const DAY = 86_400_000;

const toDate = (v: Date | string | null): Date | null => {
  if (v === null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Weekday-only difference, UTC-based so the answer never depends on the server's
 * timezone. `holidays` holds ISO dates ('2026-05-01') for the workspace calendar.
 */
export function businessDaysBetween(
  from: Date | string,
  to: Date | string,
  holidays: readonly string[] = [],
): number {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return 0;
  if (b.getTime() <= a.getTime()) return 0;

  const start = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const end = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  const closed = new Set(holidays);

  let count = 0;
  for (let t = start + DAY; t <= end; t += DAY) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (closed.has(d.toISOString().slice(0, 10))) continue;
    count += 1;
  }
  return count;
}

/** Calendar days between two instants, floored. Used for gate 5. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return 0;
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / DAY));
}

/**
 * Runs the gates in the order of §6.4 and returns the **first** failure, which is
 * also the most specific one: an opt-out beats "window closed", because that is
 * the truth the user needs to hear.
 */
export function checkEligibility(
  input: EligibilityInput,
  now: Date,
  holidays: readonly string[] = [],
): EligibilityResult {
  const sentAt = toDate(input.sentAt);
  const lastTouch = toDate(input.lastTouchAt);
  const repliedAt = toDate(input.replyReceivedAt);

  const businessDaysSinceSend = sentAt ? businessDaysBetween(sentAt, now, holidays) : 0;
  const weeksSinceSend = sentAt ? Math.max(0, (now.getTime() - sentAt.getTime()) / (7 * DAY)) : 0;

  /**
   * Gate 5 needs a date, and a CSV usually has none: it carries "3 relances",
   * not "last called on the 12th". Falling back to the send date is the same
   * choice as DECISIONS.md #9 for silence — the send date is the only anchor we
   * can defend. Without the fallback, every imported dossier with a follow-up
   * count would be rejected with "touched less than 7 days ago", a sentence that
   * would be factually false. Gate 4 already guarantees 5 business days since
   * the send, so the fallback cannot let a fresh dossier through.
   */
  const anchor = lastTouch ?? sentAt;
  const daysSinceLastTouch = anchor ? daysBetween(anchor, now) : null;

  const detail = {
    businessDaysSinceSend,
    daysSinceLastTouch,
    weeksSinceSend,
    lastTouchKnown: lastTouch !== null,
  };
  const reject = (code: RejectionCode): EligibilityResult => ({ eligible: false, code, detail });

  if (input.contactOptedOut) return reject('OPTED_OUT');
  if (input.arm !== 'treatment') return reject('HOLDOUT');
  if (input.status !== 'open') return reject('NOT_OPEN');
  if (repliedAt) return reject('REPLIED');
  if (input.touchCount >= GATES.MAX_TOUCHES) return reject('TOUCH_LIMIT');
  if (businessDaysSinceSend < GATES.MIN_BUSINESS_DAYS) return reject('TOO_SOON');
  if (input.touchCount > 0 && (daysSinceLastTouch ?? 0) < GATES.MIN_DAYS_BETWEEN_TOUCHES) {
    return reject('RECENT_TOUCH');
  }
  if (weeksSinceSend > GATES.MAX_WEEKS) return reject('WINDOW_CLOSED');

  return { eligible: true, detail };
}

/** French labels used by the empty state and the portfolio filter. */
export const REJECTION_LABELS: Record<RejectionCode, { fr: string; en: string }> = {
  HOLDOUT: { fr: 'en groupe témoin', en: 'in the control group' },
  NOT_OPEN: { fr: 'dossier déjà clos', en: 'already closed' },
  TOUCH_LIMIT: { fr: 'au plafond de contacts', en: 'at the contact limit' },
  TOO_SOON: { fr: 'en attente de délai', en: 'waiting for the delay' },
  RECENT_TOUCH: { fr: 'relancé il y a moins de 7 jours', en: 'touched less than 7 days ago' },
  REPLIED: { fr: 'a répondu', en: 'has replied' },
  OPTED_OUT: { fr: 'opposition au contact', en: 'opted out' },
  WINDOW_CLOSED: { fr: 'fenêtre fermée', en: 'window closed' },
};
