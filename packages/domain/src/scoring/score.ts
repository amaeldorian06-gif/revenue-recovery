/**
 * The scoring engine — §7.2 of the master prompt, and nothing else.
 *
 * Rules this file obeys, because everything downstream depends on them:
 *   • no clock, no RNG, no IO: `weeksSinceSend` is supplied by the caller;
 *   • deterministic to the cent for a given input;
 *   • every constant is a field of `ScoringConfig`, so a workspace can be
 *     recalibrated later without editing code (master prompt §7).
 *
 * `touch_count` deliberately does not appear here. It gates eligibility and it
 * feeds `annoyed`; adding a term for it would double-count the same fact.
 */

export const ENGINE_VERSION = '2026-10-v1';

export interface ScoringConfig {
  /** Baseline weekly reply hazard. */
  h0: number;
  /** Exponential decay of the reply hazard. */
  decay: number;
  /** Contextual multiplier applied to the cumulative hazard. */
  multContextual: number;
  /** Divider applied to the multiplier when the client is annoyed. */
  annoyDivider: number;
  /** Forward window, in weeks, over which the hazard is summed. */
  windowWeeks: number;
  /** Conversion floor, independent of the signal. */
  baseConvert: number;
  /** How much the signal moves conversion. */
  convertPerSignal: number;
  /** Best moment to ask: between 1 and 2.5 weeks. */
  optimalWindowWeeks: number;
  /** Beyond 6 weeks the window is considered closed (eligibility gate 7). */
  closedWindowWeeks: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  h0: 0.075,
  decay: 0.155,
  multContextual: 1.8,
  annoyDivider: 2.5,
  windowWeeks: 8,
  baseConvert: 0.35,
  convertPerSignal: 0.6,
  optimalWindowWeeks: 2.5,
  closedWindowWeeks: 6,
};

/**
 * A factor is a fact about the dossier that moved the score, never a verdict.
 * `weight` is filled in when the fact has one (observable count, rate); it stays
 * null for facts that only describe the situation (silence, window).
 */
export type FactorKey =
  | 'opens'
  | 'reply_history'
  | 'stage_strength'
  | 'silence_weeks'
  | 'window_closing'
  | 'value';

export interface Factor {
  key: FactorKey;
  value: number;
  weight: number | null;
}

export interface ScoreInput {
  amountCents: number;
  /** Float — a proposal sent 3 days ago is 0.43 week. */
  weeksSinceSend: number;
  /** 0..1, produced by `signal()` from observations only. */
  signal: number;
  annoyed: boolean;
  config?: Partial<ScoringConfig>;
  /**
   * Extra observable facts used **only** to enrich the explanation payload.
   * They never change the numbers: the formula of §7.2 does not read them.
   */
  context?: {
    opens14d?: number;
    stage?: string;
    /** 0.30–0.85, from `STAGE_SCORE`: what the salesperson declared. */
    stageScore?: number;
    replyHistoryRate?: number | null;
  };
}

export interface ScoreResult {
  scoreCents: number;
  expectedValueCents: number;
  pReply: number;
  pConvert: number;
  urgency: number;
  factors: Factor[];
  engineVersion: string;
}

export function resolveConfig(overrides?: Partial<ScoringConfig>): ScoringConfig {
  return { ...DEFAULT_SCORING_CONFIG, ...(overrides ?? {}) };
}

/** §7.2, verbatim. Kept as one readable function rather than seven helpers. */
export function score(input: ScoreInput): ScoreResult {
  const cfg = resolveConfig(input.config);
  const amount = Math.max(0, input.amountCents);
  const w = Math.max(0, input.weeksSinceSend);
  const signal = clamp01(input.signal);

  const hazard = (x: number) =>
    cfg.h0 * Math.exp(-cfg.decay * x) * (0.45 + 1.55 * signal);

  let cum = 0;
  for (let i = 0; i < cfg.windowWeeks; i += 1) cum += hazard(w + i);

  const timing = w < 1.0 ? 0.85 : w > 5.0 ? 0.7 : 1.0;
  const mult = cfg.multContextual * timing * (input.annoyed ? 1 / cfg.annoyDivider : 1);

  const pReply = 1 - Math.exp(-cum * mult);
  const pConvert = cfg.baseConvert + cfg.convertPerSignal * signal;
  const expected = amount * pReply * pConvert;

  const urgency =
    w < 1.0
      ? 0.55 + 0.45 * (w / 1.0)
      : w <= cfg.optimalWindowWeeks
        ? 1.0
        : Math.max(0.22, Math.exp(-0.1 * (w - cfg.optimalWindowWeeks)));

  const scoreCents = Math.round(expected * urgency);

  return {
    scoreCents,
    expectedValueCents: Math.round(expected),
    pReply: round6(pReply),
    pConvert: round6(pConvert),
    urgency: round6(urgency),
    factors: buildFactors(w, amount, signal, input, cfg),
    engineVersion: ENGINE_VERSION,
  };
}

/**
 * Ordered most-explainable first: what the client did, then how long it has been
 * silent, then why it is urgent. The UI renders at most three — the order is the
 * contract, not a detail.
 */
function buildFactors(
  w: number,
  amountCents: number,
  signal: number,
  input: ScoreInput,
  cfg: ScoringConfig,
): Factor[] {
  const factors: Factor[] = [];
  const ctx = input.context ?? {};

  if (typeof ctx.opens14d === 'number' && ctx.opens14d > 0) {
    factors.push({ key: 'opens', value: ctx.opens14d, weight: Math.min(ctx.opens14d, 6) / 6 * 0.3 });
  }
  // A 0 % reply history is not a fact about the client, it is the shape of a
  // freshly imported CSV where nobody has ever been recorded as replying. Shown
  // as a factor it would read as an accusation ("this client never answers"), so
  // it only appears once there is at least one reply to compute a rate from.
  if (typeof ctx.replyHistoryRate === 'number' && ctx.replyHistoryRate > 0) {
    factors.push({ key: 'reply_history', value: ctx.replyHistoryRate, weight: 0.22 });
  }
  if (ctx.stage) {
    factors.push({ key: 'stage_strength', value: ctx.stageScore ?? signal, weight: 0.34 });
  }
  factors.push({ key: 'silence_weeks', value: round2(w), weight: null });

  const overdueDays = Math.max(0, Math.round((w - cfg.optimalWindowWeeks) * 7));
  if (overdueDays > 0) {
    factors.push({ key: 'window_closing', value: overdueDays, weight: null });
  }
  factors.push({ key: 'value', value: amountCents, weight: null });

  return factors;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
