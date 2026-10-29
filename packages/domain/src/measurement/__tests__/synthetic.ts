import { mulberry32 } from '../random.ts';
import type { OutcomeRow } from '../attribution.ts';

/**
 * Synthetic pipelines for the honesty suite.
 *
 * A dataset is generated from a seeded generator, never from `Math.random`: an
 * honesty test that fails one run in ten is worse than no test, because the team
 * learns to re-run it.
 */
export interface SyntheticOptions {
  n: number;
  seed: number;
  /** Share of opportunities assigned to the holdout. */
  rate?: number;
  /** Win probability of the holdout arm. */
  pHoldout?: number;
  /** Win probability of the treatment arm. Defaults to the holdout's (true null). */
  pTreatment?: number;
  /** Fixed deal amount; ignored when `amountRange` is given. */
  amountCents?: number;
  amountRange?: [number, number];
  /** Revenue multiplier applied to won deals of the treatment arm. */
  amountLift?: number;
}

export const RATE = 0.2;
export const AMOUNT = 900_000;

export function syntheticRows(opts: SyntheticOptions): OutcomeRow[] {
  const rate = opts.rate ?? RATE;
  const pHoldout = opts.pHoldout ?? 0.7;
  const pTreatment = opts.pTreatment ?? pHoldout;
  const rng = mulberry32(opts.seed);
  const rows: OutcomeRow[] = [];

  for (let i = 0; i < opts.n; i += 1) {
    const holdout = rng() < rate;
    const won = rng() < (holdout ? pHoldout : pTreatment);
    const base = opts.amountRange
      ? Math.round(opts.amountRange[0] + rng() * (opts.amountRange[1] - opts.amountRange[0]))
      : (opts.amountCents ?? AMOUNT);
    const amount = !holdout && opts.amountLift ? Math.round(base * opts.amountLift) : base;
    rows.push({ arm: holdout ? 'holdout' : 'treatment', won, amountCents: amount });
  }
  return rows;
}

/** A dataset with a true relative lift of `lift` on the win rate (0.2 = +20 %). */
export function withLift(n: number, lift: number, seed: number): OutcomeRow[] {
  const pHoldout = 0.7;
  return syntheticRows({
    n,
    seed,
    rate: RATE,
    pHoldout,
    pTreatment: Math.min(1, pHoldout * (1 + lift)),
    amountCents: AMOUNT,
  });
}
