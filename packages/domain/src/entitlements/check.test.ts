import { describe, it, expect } from 'vitest';
import { check, PLANS, clientsNeededForMrr, type Usage } from './check.ts';

const usage = (o: Partial<Usage> = {}): Usage => ({
  proposalsTracked: 0, emailsSent: 0, seats: 1, mailboxes: 1, ...o,
});

describe('import — Starter boundary (30/month)', () => {
  it('29 tracked + 1 → allowed, no warning', () => {
    expect(check('starter', usage({ proposalsTracked: 29 }), 'import_proposals', { incoming: 1 }))
      .toMatchObject({ allowed: true, softBlock: false });
  });
  it('30 tracked + 1 → allowed with a warning (exactly at limit+1 ≤ 33)', () => {
    expect(check('starter', usage({ proposalsTracked: 30 }), 'import_proposals', { incoming: 1 }))
      .toMatchObject({ allowed: true, softBlock: true, reasonCode: 'SOFT_LIMIT_REACHED' });
  });
  it('31 tracked + 1 → still allowed with a warning', () => {
    expect(check('starter', usage({ proposalsTracked: 31 }), 'import_proposals', { incoming: 1 }).allowed).toBe(true);
  });
  it('33 tracked + 1 → refused (above 110 %)', () => {
    expect(check('starter', usage({ proposalsTracked: 33 }), 'import_proposals', { incoming: 1 }))
      .toMatchObject({ allowed: false, reasonCode: 'PLAN_LIMIT_EXCEEDED' });
  });
  it('a bulk import that would overshoot is refused as a whole', () => {
    expect(check('starter', usage({ proposalsTracked: 25 }), 'import_proposals', { incoming: 10 }).allowed).toBe(false);
  });
  it('reports the remaining allowance', () => {
    expect(check('starter', usage({ proposalsTracked: 12 }), 'import_proposals', { incoming: 1 }).remaining).toBe(18);
  });
});

describe('import — Growth and Scale (90 / 300)', () => {
  it('89 + 1 → allowed without warning', () => {
    expect(check('growth', usage({ proposalsTracked: 89 }), 'import_proposals', { incoming: 1 }).softBlock).toBe(false);
  });
  it('90 + 1 → warning, not refused', () => {
    expect(check('growth', usage({ proposalsTracked: 90 }), 'import_proposals', { incoming: 1 }))
      .toMatchObject({ allowed: true, softBlock: true });
  });
  it('99 + 1 → refused for Growth', () => {
    expect(check('growth', usage({ proposalsTracked: 99 }), 'import_proposals', { incoming: 1 }).allowed).toBe(false);
  });
  it('330 + 1 → refused for Scale', () => {
    expect(check('scale', usage({ proposalsTracked: 330 }), 'import_proposals', { incoming: 1 }).allowed).toBe(false);
  });
});

describe('seats', () => {
  it('Starter allows 1 seat only', () => {
    expect(check('starter', usage({ seats: 1 }), 'add_seat').allowed).toBe(false);
  });
  it('Growth allows a 4th seat but not a 5th', () => {
    expect(check('growth', usage({ seats: 3 }), 'add_seat').allowed).toBe(true);
    expect(check('growth', usage({ seats: 4 }), 'add_seat').allowed).toBe(false);
  });
  it('Scale allows a 12th seat but not a 13th', () => {
    expect(check('scale', usage({ seats: 11 }), 'add_seat').allowed).toBe(true);
    expect(check('scale', usage({ seats: 12 }), 'add_seat').allowed).toBe(false);
  });
});

describe('mailboxes', () => {
  it('Starter: 1', () => {
    expect(check('starter', usage({ mailboxes: 1 }), 'connect_mailbox').allowed).toBe(false);
  });
  it('Growth: 2', () => {
    expect(check('growth', usage({ mailboxes: 1 }), 'connect_mailbox').allowed).toBe(true);
    expect(check('growth', usage({ mailboxes: 2 }), 'connect_mailbox').allowed).toBe(false);
  });
  it('Scale: 5', () => {
    expect(check('scale', usage({ mailboxes: 4 }), 'connect_mailbox').allowed).toBe(true);
    expect(check('scale', usage({ mailboxes: 5 }), 'connect_mailbox').allowed).toBe(false);
  });
});

describe('plan features', () => {
  it('the API is unavailable on Starter', () => {
    expect(check('starter', usage(), 'use_api')).toMatchObject({ allowed: false, reasonCode: 'PLAN_FEATURE_UNAVAILABLE' });
  });
  it('the API is read-only on Growth and read-write on Scale', () => {
    expect(check('growth', usage(), 'use_api').allowed).toBe(true);
    expect(check('scale', usage(), 'use_api').limit).toBe(2);
  });
  it('the holdout is configurable on Scale only', () => {
    expect(check('starter', usage(), 'configure_holdout').allowed).toBe(false);
    expect(check('growth', usage(), 'configure_holdout').allowed).toBe(false);
    expect(check('scale', usage(), 'configure_holdout', { requestedHoldoutRate: 0.2 }).allowed).toBe(true);
  });
  it('refuses a holdout rate outside 10–30 % even on Scale', () => {
    expect(check('scale', usage(), 'configure_holdout', { requestedHoldoutRate: 0.5 }).allowed).toBe(false);
    expect(check('scale', usage(), 'configure_holdout', { requestedHoldoutRate: 0.05 }).allowed).toBe(false);
  });
  // Criterion 3, holdout boundaries: 9.9 / 10 / 30 / 30.1.
  it('holdout range boundaries: 9.9 refused, 10 and 30 allowed, 30.1 refused', () => {
    const ask = (r: number) => check('scale', usage(), 'configure_holdout', { requestedHoldoutRate: r });
    expect(ask(0.099).allowed).toBe(false);
    expect(ask(0.10).allowed).toBe(true);
    expect(ask(0.30).allowed).toBe(true);
    expect(ask(0.301).allowed).toBe(false);
  });
});

describe('send_email mirrors the plan ceiling (criterion 3)', () => {
  it('below the limit: allowed, no warning', () => {
    expect(check('starter', usage({ proposalsTracked: 25 }), 'send_email').softBlock).toBe(false);
  });
  it('at the limit: allowed with a soft block', () => {
    expect(check('starter', usage({ proposalsTracked: 30 }), 'send_email'))
      .toMatchObject({ allowed: true, softBlock: true, reasonCode: 'SOFT_LIMIT_REACHED' });
  });
  it('above the hard ceiling: refused', () => {
    expect(check('starter', usage({ proposalsTracked: 34 }), 'send_email').allowed).toBe(false);
  });
  it('seat boundary below the limit: Starter still accepts its first seat', () => {
    expect(check('starter', usage({ seats: 0 }), 'add_seat').allowed).toBe(true);
  });
});

describe('commercial arithmetic', () => {
  it('encodes the 100 k€ MRR plan mix', () => {
    const mix = PLANS.starter.priceMonthlyEur * 30 + PLANS.growth.priceMonthlyEur * 50 + PLANS.scale.priceMonthlyEur * 40;
    expect(mix).toBeGreaterThanOrEqual(100_000);
    expect(mix).toBe(103_520);
  });
  it('computes the clients needed per plan', () => {
    expect(clientsNeededForMrr(100_000, 'starter')).toBe(335);
    expect(clientsNeededForMrr(100_000, 'growth')).toBe(144);
    expect(clientsNeededForMrr(100_000, 'scale')).toBe(68);
  });
});
