/**
 * The honesty suite — criteria 1, 2 and 6 of phase 05.
 *
 * These three tests are the reason the phase exists. They are the only tests in
 * the codebase allowed to be slow, and the only ones that may never be skipped:
 * if the estimator starts flattering us, this file is what catches it.
 */
import { describe, it, expect } from 'vitest';
import { attribute } from '../attribution.ts';
import { syntheticRows, withLift, AMOUNT } from './synthetic.ts';

describe('1. recovery — the estimator finds a lift that is really there', () => {
  it('returns +20 % ±3 points on 20 000 dossiers where the treatment truly earns +20 %', () => {
    // Seed fixed a priori (the date of this phase). The point estimate is the
    // estimator, not the truth: on 20 000 dossiers the standard error of the
    // relative effect is about one point, so the ±3 band is roughly three of them.
    const rows = withLift(20_000, 0.2, 20_261_025);
    const result = attribute(rows, { resamples: 10_000, seed: 7 });

    expect(result.levelA.relativeEffect).not.toBeNull();
    expect(result.levelA.relativeEffect!).toBeGreaterThan(0.17);
    expect(result.levelA.relativeEffect!).toBeLessThan(0.23);
    expect(result.levelA.significant).toBe(true);
    expect(result.levelA.ciLow).toBeGreaterThan(0);
    expect(result.levelA.nHoldout).toBeGreaterThan(3800);
    expect(result.levelA.nTreatment).toBeGreaterThan(15_500);
  }, 120_000);
});

describe('2. null — no effect must not become a result', () => {
  it('covers zero in at least 190 of 200 runs, and claims significance in at most 10', () => {
    let covered = 0;
    let significant = 0;
    const N = 200;

    for (let k = 0; k < N; k += 1) {
      // 1 000 dossiers, heterogeneous amounts, identical win probability in both
      // arms: there is nothing to find, and the product must say so.
      const rows = syntheticRows({
        n: 1000,
        seed: 1000 + k,
        rate: 0.2,
        pHoldout: 0.7,
        amountRange: [50_000, 2_000_000],
      });
      const r = attribute(rows, { resamples: 1000, seed: 99 + k });
      if (r.levelA.ciLow <= 0 && r.levelA.ciHigh >= 0) covered += 1;
      if (r.levelA.significant) significant += 1;
    }

    expect(covered).toBeGreaterThanOrEqual(190);
    expect(significant).toBeLessThanOrEqual(10);
  }, 120_000);
});

describe('6. determinism — a confidence interval is not a slot machine', () => {
  it('returns the identical interval for the same input across two calls', () => {
    const rows = withLift(4000, 0.2, 4242);
    const a = attribute(rows, { resamples: 4000, seed: 11 });
    const b = attribute(rows, { resamples: 4000, seed: 11 });

    expect(a.levelA.ciLow).toBe(b.levelA.ciLow);
    expect(a.levelA.ciHigh).toBe(b.levelA.ciHigh);
    expect(a.levelA.pValue).toBe(b.levelA.pValue);
    expect(a.levelA.relativeCi).toEqual(b.levelA.relativeCi);
  }, 60_000);

  it('widens the relative interval as the sample shrinks', () => {
    const width = (n: number) => {
      const r = attribute(withLift(n, 0.2, 4242), { resamples: 4000, seed: 11 });
      const ci = r.levelA.relativeCi!;
      return ci[1] - ci[0];
    };

    const big = width(4000);
    const small = width(400);
    expect(small).toBeGreaterThan(big * 1.5);

    // The absolute interval is a *total*: it grows with the cohort even when the
    // relative one narrows. Stating this in a test is cheaper than explaining it
    // to a customer who spots it on the chart.
    const bigAbs = attribute(withLift(4000, 0.2, 4242), { resamples: 2000, seed: 11 });
    const smallAbs = attribute(withLift(400, 0.2, 4242), { resamples: 2000, seed: 11 });
    expect(bigAbs.levelA.ciHigh - bigAbs.levelA.ciLow).toBeGreaterThan(
      smallAbs.levelA.ciHigh - smallAbs.levelA.ciLow,
    );
  }, 60_000);

  it('different seeds give different intervals — the point estimate does not move', () => {
    const rows = withLift(2000, 0.2, 777);
    const a = attribute(rows, { resamples: 500, seed: 1 });
    const b = attribute(rows, { resamples: 500, seed: 2 });
    expect(a.levelA.estimateCents).toBe(b.levelA.estimateCents);
    expect(a.levelA.ciLow).not.toBe(b.levelA.ciLow);
  }, 60_000);
});

describe('the estimator never invents a precision it does not have', () => {
  it('returns requiredSample = null when the effect is not positive', () => {
    const rows = syntheticRows({ n: 500, seed: 3, rate: 0.2, pHoldout: 0.7 });
    const r = attribute(rows, { resamples: 500, seed: 3 });
    if (r.levelA.estimateCents <= 0) expect(r.requiredSample).toBeNull();
    else expect(r.requiredSample!.perArm).toBeGreaterThan(0);
  });

  it('keeps B = C + A on the recomputed data (the identity is the sanity check)', () => {
    const r = attribute(withLift(3000, 0.2, 999), { resamples: 500, seed: 5 });
    expect(Math.abs(r.levelB.revenueCents - r.levelC.revenueCents - r.levelA.estimateCents)).toBeLessThanOrEqual(
      Math.ceil(AMOUNT * 0.001),
    );
  });

  it('flags a stored gross revenue that the causal estimate cannot explain', () => {
    const rows = withLift(3000, 0.2, 999);
    const honest = attribute(rows, { resamples: 500, seed: 5 });
    // A tolerance, not a trap: a deal amount corrected by a few percent must not
    // raise an alarm. A gross revenue twice the causal estimate must.
    const drift = attribute(rows, {
      resamples: 500, seed: 5,
      storedTreatmentCents: honest.levelB.revenueCents + Math.round(honest.levelA.estimateCents * 0.05),
    });
    const tampered = attribute(rows, {
      resamples: 500, seed: 5,
      storedTreatmentCents: honest.levelB.revenueCents + Math.abs(honest.levelA.estimateCents) * 2,
    });
    expect(honest.coherence.verdict).toBe('ok');
    expect(drift.coherence.verdict).toBe('ok');
    expect(tampered.coherence.verdict).toBe('investigate');
    expect(tampered.coherence.relativeGapPct).toBeGreaterThan(100);
  });
});
