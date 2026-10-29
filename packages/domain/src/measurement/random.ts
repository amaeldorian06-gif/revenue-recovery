/**
 * Deterministic randomness.
 *
 * The bootstrap must return the same interval twice for the same input — a
 * confidence interval that moves when you reload the page is not a confidence
 * interval, it is a slot machine. `mulberry32` is 30 lines, has no dependency, and
 * is good enough for resampling (we are not generating keys).
 */
export type RngSeed = number;

export function mulberry32(seed: RngSeed): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolated percentile on a sorted array. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0]!;
  const pos = p * (n - 1);
  const lower = Math.floor(pos);
  const upper = Math.min(n - 1, lower + 1);
  const weight = pos - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** Integer in [min, max], driven by an existing generator. */
export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
