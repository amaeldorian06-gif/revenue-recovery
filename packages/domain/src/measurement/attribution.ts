/**
 * Attribution — the only place in the product where a number is allowed to be
 * called "gain".
 *
 * Three levels, always displayed together (§10.2):
 *   A — causal      : (rev_t/n_t − rev_h/n_h) × n_t, with a 95 % bootstrap CI
 *   B — gross       : revenue of won deals in the treatment arm
 *   C — counterfactual: what the holdout would have produced at the treatment size
 *
 * Two rules that this file exists to enforce:
 *   • the bootstrap resamples **opportunities**, never aggregates. Resampling a
 *     ratio produces an interval that is always too narrow, and always looks
 *     significant — the exact bug every tool in this category ships.
 *   • a null or non-positive effect returns `requiredSample: null` instead of a
 *     number. "Effet non estimable" is a true sentence; "∞ dossiers" is not.
 */
import { mulberry32, percentile, type RngSeed } from './random.ts';

export type Arm = 'treatment' | 'holdout';

export interface OutcomeRow {
  arm: Arm;
  won: boolean;
  /** Revenue of the deal when won; 0 otherwise. */
  amountCents: number;
  /** Only used to select the cohort upstream, kept for traceability. */
  sentAt?: Date | string;
}

export interface ArmSummary {
  n: number;
  wins: number;
  revenueCents: number;
  /** Mean revenue per opportunity — the only quantity the estimator uses. */
  meanCents: number;
  winRate: number;
  /** Wilson 95 % interval on the win rate: well defined on tiny samples. */
  winRateCi: [number, number];
  sdCents: number;
}

export interface LevelA {
  estimateCents: number;
  ciLow: number;
  ciHigh: number;
  pValue: number;
  significant: boolean;
  /** Effect relative to the counterfactual (C). 0.2 = "+20 %". */
  relativeEffect: number | null;
  /**
   * The same interval on the relative scale. The absolute interval is a *total*
   * and therefore grows with the cohort — a bigger sample means a bigger number,
   * with a proportionally bigger interval. The relative one is the scale on which
   * "the interval narrows as the sample grows" is actually true, and it is the
   * scale the screen shows ("+14,9 %").
   */
  relativeCi: [number, number] | null;
  nTreatment: number;
  nHoldout: number;
  resamples: number;
  seed: number;
}

export interface LevelB {
  revenueCents: number;
  nWon: number;
  nOpportunities: number;
  winRate: number;
  winRateCi: [number, number];
}

export interface LevelC {
  /** Holdout revenue scaled to the treatment arm size. */
  revenueCents: number;
  /** The unscaled holdout revenue, shown so the reader can check the maths. */
  revenueRawCents: number;
  rescaledBy: number;
  nWon: number;
  nOpportunities: number;
  winRate: number;
  winRateCi: [number, number];
}

export interface Coherence {
  /** B − C: what the causal claim implies the product added. */
  bMinusC: number;
  a: number;
  /** |(B − C) − A| relative to |A|, in percent. Null when A is 0. */
  relativeGapPct: number | null;
  toleranceCents: number;
  verdict: 'ok' | 'investigate';
}

export interface RequiredSample {
  perArm: number;
  currentPerArm: number;
  progressPct: number;
}

export interface AttributionResult {
  levelA: LevelA;
  levelB: LevelB;
  levelC: LevelC;
  coherence: Coherence;
  requiredSample: RequiredSample | null;
  treatment: ArmSummary;
  holdout: ArmSummary;
}

export interface AttributeOptions {
  seed?: number;
  resamples?: number;
  /**
   * Gross revenue as recorded elsewhere (the weekly snapshot). When provided, the
   * coherence check compares the estimator against the stored figures instead of
   * the recomputed ones — which is exactly how a real divergence surfaces: a deal
   * amount corrected after the fact, a duplicate import, a manual status change.
   */
  storedTreatmentCents?: number;
  storedHoldoutCents?: number;
}

export const DEFAULT_RESAMPLES = 10_000;
export const DEFAULT_SEED = 20_261_025;
const Z = 1.96;

/** Wilson score interval — stable on small samples, unlike the normal approximation. */
export function wilson(successes: number, n: number, z = Z): [number, number] {
  if (n <= 0) return [0, 0];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const low = Math.max(0, (centre - margin) / denom);
  const high = Math.min(1, (centre + margin) / denom);
  return [round4(low), round4(high)];
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

function summarise(rows: readonly OutcomeRow[]): ArmSummary {
  const n = rows.length;
  let wins = 0;
  let revenue = 0;
  let sumSq = 0;
  for (const r of rows) {
    const v = r.won ? r.amountCents : 0;
    if (r.won) wins += 1;
    revenue += v;
    sumSq += v * v;
  }
  const mean = n === 0 ? 0 : revenue / n;
  const variance = n === 0 ? 0 : Math.max(0, sumSq / n - mean * mean);
  return {
    n,
    wins,
    revenueCents: revenue,
    meanCents: round4(mean),
    winRate: n === 0 ? 0 : round4(wins / n),
    winRateCi: wilson(wins, n),
    sdCents: Math.sqrt(variance),
  };
}

/**
 * Bootstrap the difference of means, one resample = n draws with replacement
 * inside each arm. Returns every replicate so the caller can derive the CI and a
 * p-value that lives on the same quantity as the interval (§10.3).
 */
export function bootstrapDifference(
  treatment: Float64Array,
  holdout: Float64Array,
  opts: { resamples?: number; seed?: number } = {},
): { replicates: Float64Array; seed: number; resamples: number } {
  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const seed = opts.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed) as () => number;
  const nt = treatment.length;
  const nh = holdout.length;
  const out = new Float64Array(resamples);

  if (nt === 0 || nh === 0) return { replicates: out, seed, resamples };

  for (let b = 0; b < resamples; b += 1) {
    let st = 0;
    for (let i = 0; i < nt; i += 1) st += treatment[(rng() * nt) | 0]!;
    let sh = 0;
    for (let i = 0; i < nh; i += 1) sh += holdout[(rng() * nh) | 0]!;
    out[b] = (st / nt - sh / nh) * nt;
  }
  return { replicates: out, seed, resamples };
}

export function attribute(rows: readonly OutcomeRow[], opts: AttributeOptions = {}): AttributionResult {
  const treatment = summarise(rows.filter((r) => r.arm === 'treatment'));
  const holdout = summarise(rows.filter((r) => r.arm === 'holdout'));

  const treatmentValues = Float64Array.from(
    rows.filter((r) => r.arm === 'treatment').map((r) => (r.won ? r.amountCents : 0)),
  );
  const holdoutValues = Float64Array.from(
    rows.filter((r) => r.arm === 'holdout').map((r) => (r.won ? r.amountCents : 0)),
  );

  const { replicates, seed, resamples } = bootstrapDifference(treatmentValues, holdoutValues, {
    resamples: opts.resamples,
    seed: opts.seed,
  });

  const sorted = Float64Array.from(replicates).sort();
  const ciLow = sorted.length === 0 ? 0 : percentile(sorted, 0.025);
  const ciHigh = sorted.length === 0 ? 0 : percentile(sorted, 0.975);

  const estimateCents = (treatment.meanCents - holdout.meanCents) * treatment.n;

  // p-value on the same quantity as the interval: share of replicates on the
  // wrong side of zero, doubled. Never a t-test on another statistic.
  let below = 0;
  let above = 0;
  for (let i = 0; i < replicates.length; i += 1) {
    const v = replicates[i]!;
    if (v <= 0) below += 1;
    if (v >= 0) above += 1;
  }
  const tail = sorted.length === 0 ? 0.5 : Math.min(below, above) / sorted.length;
  const pValue = round4(Math.min(1, 2 * tail));

  const significant = ciLow > 0 || ciHigh < 0;

  // C = holdout mean scaled to the treatment size. A/C is the relative effect, and
  // it is meaningless without C, which is why both are always returned.
  const counterfactual = holdout.meanCents * treatment.n;
  const relativeEffect = counterfactual > 0 ? round4(estimateCents / counterfactual) : null;
  const relativeCi: [number, number] | null =
    counterfactual > 0 && sorted.length > 0
      ? [
          round4(percentile(sorted, 0.025) / counterfactual),
          round4(percentile(sorted, 0.975) / counterfactual),
        ]
      : null;

  const levelB: LevelB = {
    revenueCents: treatment.revenueCents,
    nWon: treatment.wins,
    nOpportunities: treatment.n,
    winRate: treatment.winRate,
    winRateCi: treatment.winRateCi,
  };

  const rescaledBy = holdout.n > 0 ? treatment.n / holdout.n : 0;
  const levelC: LevelC = {
    revenueCents: Math.round(holdout.revenueCents * rescaledBy),
    revenueRawCents: holdout.revenueCents,
    rescaledBy: round4(rescaledBy),
    nWon: Math.round(holdout.wins * rescaledBy),
    nOpportunities: treatment.n,
    // A win rate is invariant under rescaling: showing a rescaled rate would
    // suggest a precision the holdout does not have.
    winRate: holdout.winRate,
    winRateCi: holdout.winRateCi,
  };

  const bCents = opts.storedTreatmentCents ?? levelB.revenueCents;
  const cCents = opts.storedHoldoutCents !== undefined
    ? Math.round(opts.storedHoldoutCents * rescaledBy)
    : levelC.revenueCents;
  const bMinusC = bCents - cCents;
  const gap = Math.abs(bMinusC - estimateCents);
  const toleranceCents = Math.round(0.25 * Math.abs(estimateCents) + 3000);

  const coherence: Coherence = {
    bMinusC,
    a: Math.round(estimateCents),
    relativeGapPct:
      estimateCents === 0 ? null : round4(((bMinusC - estimateCents) / Math.abs(estimateCents)) * 100),
    toleranceCents,
    verdict: gap <= toleranceCents ? 'ok' : 'investigate',
  };

  return {
    levelA: {
      estimateCents: Math.round(estimateCents),
      ciLow: Math.round(ciLow),
      ciHigh: Math.round(ciHigh),
      pValue,
      significant,
      relativeEffect,
      relativeCi,
      nTreatment: treatment.n,
      nHoldout: holdout.n,
      resamples,
      seed,
    },
    levelB,
    levelC,
    coherence,
    requiredSample: requiredSample(treatment, holdout),
    treatment,
    holdout,
  };
}

/**
 * `perArm = ceil((1.96 × sd / |effect|)²)`.
 * Null when the effect is not positive: there is no honest number to show, and a
 * fabricated one would read as "almost there" forever.
 */
export function requiredSample(
  treatment: ArmSummary,
  holdout: ArmSummary,
): RequiredSample | null {
  const effect = treatment.meanCents - holdout.meanCents;
  if (!(effect > 0)) return null;

  const n = treatment.n + holdout.n;
  const pooledVariance =
    n === 0
      ? 0
      : (treatment.n * treatment.sdCents ** 2 + holdout.n * holdout.sdCents ** 2) / n;
  const sd = Math.sqrt(pooledVariance);
  if (sd === 0) return null;

  const perArm = Math.ceil(((Z * sd) / effect) ** 2);
  const currentPerArm = Math.min(treatment.n, holdout.n);
  return {
    perArm,
    currentPerArm,
    progressPct: Math.min(100, Math.round((100 * currentPerArm) / Math.max(1, perArm))),
  };
}

export const _internal = { summarise, round4 };
export type { RngSeed };
