/**
 * The four detection states of master prompt §6.3.
 *
 * Priority matters: a dossier can match several rules at once (it is both late
 * and silent), and showing two states makes the portfolio unreadable. The
 * classifier returns exactly one, plus a reason key the UI turns into a sentence.
 * Nothing is stored: state is derived and therefore never stale.
 */

export type DetectionState = 'no_reply' | 'late_action' | 'abnormal_silence' | 'watch';

export const SILENCE_THRESHOLD_DAYS: Record<string, number> = {
  proposal_sent: 10,
  followup_1: 7,
  followup_2: 7,
  followup_3: 14,
  verbal_yes: 3,
  negotiation: 5,
  other: 10,
};

export interface ClassifyInput {
  amountCents: number;
  stage: string;
  sentAt: Date | string;
  lastTouchAt: Date | string | null;
  touchCount: number;
  replyReceivedAt: Date | string | null;
  status: string;
  expectedActionAt?: Date | string | null;
  now: Date;
  /**
   * 80th percentile of the workspace's open amounts. Master prompt §6.3 defines
   * `watch` as "amount in the top 20 %"; without the portfolio we cannot compute
   * it, so the caller passes it in. Undefined means "no reference": the dossier
   * is still `watch`, only the wording changes.
   */
  topValueThresholdCents?: number;
}

export interface Classification {
  state: DetectionState;
  reasonKey:
    | 'never_followed_up'
    | 'overdue_action'
    | 'silent_for'
    | 'high_value_watch'
    | 'recently_touched';
  params: { days?: number; stage?: string; amountCents?: number };
  daysSinceSend: number;
  daysSinceLastTouch: number;
}

const DAY = 86_400_000;

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function classify(input: ClassifyInput): Classification {
  const sentAt = toDate(input.sentAt);
  if (!sentAt) throw new Error('classify: sentAt is required and must be a valid date');
  const lastTouch = toDate(input.lastTouchAt);
  const now = input.now;

  const daysSinceSend = Math.max(0, Math.floor((now.getTime() - sentAt.getTime()) / DAY));
  const daysSinceLastTouch = Math.max(
    0,
    Math.floor((now.getTime() - (lastTouch ?? sentAt).getTime()) / DAY),
  );
  const base = { daysSinceSend, daysSinceLastTouch };

  const isHighValue =
    input.topValueThresholdCents !== undefined && input.amountCents >= input.topValueThresholdCents;

  // A closed or answered dossier is not "neglected": there is nothing to detect.
  if (input.status !== 'open' || input.replyReceivedAt) {
    return { state: 'watch', reasonKey: 'recently_touched', params: {}, ...base };
  }

  // 1. Never followed up — the main leak, and the most actionable.
  if (input.touchCount === 0) {
    return { state: 'no_reply', reasonKey: 'never_followed_up', params: { days: daysSinceSend }, ...base };
  }

  // 2. An action was planned and its date has passed.
  const expected = toDate(input.expectedActionAt);
  if (expected && expected.getTime() < now.getTime()) {
    return {
      state: 'late_action',
      reasonKey: 'overdue_action',
      params: { days: Math.floor((now.getTime() - expected.getTime()) / DAY), stage: input.stage },
      ...base,
    };
  }

  // 3. Silence beyond the stage threshold.
  const threshold = SILENCE_THRESHOLD_DAYS[input.stage] ?? 10;
  if (daysSinceLastTouch >= threshold) {
    return {
      state: 'abnormal_silence',
      reasonKey: 'silent_for',
      params: { days: daysSinceLastTouch, stage: input.stage },
      ...base,
    };
  }

  // 4. Nothing is going wrong (yet). The state is `watch` either way; the reason
  // distinguishes a big dossier worth a look from a deal that is simply on track.
  return {
    state: 'watch',
    reasonKey: isHighValue ? 'high_value_watch' : 'recently_touched',
    params: { amountCents: input.amountCents },
    ...base,
  };
}

/**
 * The 80th percentile of a workspace's open amounts — the line above which an
 * opportunity is "top 20 %". Nearest-rank on a copy, so the portfolio array is
 * never reordered by a read.
 */
export function topValueThreshold(amountsCents: readonly number[], p = 0.8): number {
  const values = amountsCents.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const rank = Math.ceil(p * values.length);
  return values[Math.min(values.length - 1, Math.max(0, rank - 1))]!;
}
