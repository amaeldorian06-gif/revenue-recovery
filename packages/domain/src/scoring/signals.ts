/**
 * Signal score — §7.1. Built from what we can actually observe at runtime.
 *
 * Why the "quality" of a client is not used here
 * ----------------------------------------------
 * The simulation that calibrated the product draws a latent `quality` per client
 * and derives opens, replies and wins from it. That variable does not exist in
 * production: nobody can query "how good is this lead". Only its noisy proxy is
 * observable — how many times the document was opened, how often this contact
 * answered in the past, how many deals were won with this company, and the stage
 * the salesperson set.
 *
 * A future contributor reading the simulation will be tempted to "improve" the
 * engine by feeding the real quality in. There is no such column, no such API,
 * and inventing one would make the score unfalsifiable: it would look right in
 * backtests and be unexplainable to the user opening the screen at 8 a.m.
 */

export const STAGE_SCORE: Record<string, number> = {
  proposal_sent: 0.35,
  followup_1: 0.45,
  followup_2: 0.4,
  followup_3: 0.3,
  verbal_yes: 0.85,
  negotiation: 0.7,
  other: 0.35,
};

export const SIGNAL_DEFAULT_REPLY_RATE = 0.35;
/**
 * Guards, not active constraints: with the weights and stage table above the
 * signal can only reach 0.102 … 0.949. The bounds exist so a future stage table
 * with a 1.0 entry still cannot produce an impossible probability. Asserted in
 * golden.test.ts so the dead clamp is not "cleaned up" by mistake.
 */
export const SIGNAL_MIN = 0.02;
export const SIGNAL_MAX = 0.98;

export interface SignalInput {
  /** Document/email opens in the last 14 days. Unknown → 0, not an average. */
  opens14d?: number;
  /** Rolling reply rate for this contact or company. Unknown → default. */
  replyHistoryRate?: number | null;
  /** Deals already won with this client. Unknown → 0. */
  wonDealsWithClient?: number;
  stage: string;
}

export interface SignalBreakdown {
  value: number;
  opens: number;
  replyHistory: number;
  wonDeals: number;
  stage: number;
  clamped: boolean;
}

export function signal(input: SignalInput): SignalBreakdown {
  const opens = Math.max(0, input.opens14d ?? 0);
  const replyRate =
    input.replyHistoryRate === null || input.replyHistoryRate === undefined
      ? SIGNAL_DEFAULT_REPLY_RATE
      : Math.min(1, Math.max(0, input.replyHistoryRate));
  const won = Math.max(0, input.wonDealsWithClient ?? 0);
  const stage = STAGE_SCORE[input.stage] ?? STAGE_SCORE.other!;

  const opensPart = 0.3 * (Math.min(opens, 6) / 6);
  const replyPart = 0.22 * replyRate;
  const wonPart = 0.14 * (Math.min(won, 4) / 4);
  const stagePart = 0.34 * stage;

  const raw = opensPart + replyPart + wonPart + stagePart;
  const value = Math.min(SIGNAL_MAX, Math.max(SIGNAL_MIN, raw));

  return {
    value: Math.round(value * 1_000_000) / 1_000_000,
    opens: opensPart,
    replyHistory: replyPart,
    wonDeals: wonPart,
    stage: stagePart,
    clamped: raw !== value,
  };
}
