/**
 * Criterion 6 — seven stop rules, each constructing the state that must cancel.
 * A rule tested only through the happy path is a rule nobody has seen fire.
 */
import { describe, it, expect } from 'vitest';
import { checkStopRules, type SendState } from '../stopRules.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const base: SendState = {
  arm: 'treatment',
  opportunityStatus: 'open',
  touchCount: 1,
  lastTouchAt: new Date('2026-10-10T09:00:00Z'), // 15 days
  replyReceivedAt: null,
  contactOptedOut: false,
  workspaceStatus: 'active',
  sendsToday: 0,
};

const check = (patch: Partial<SendState>) => checkStopRules({ ...base, ...patch }, NOW);

describe('the seven stop rules', () => {
  it('sends when nothing is wrong', () => {
    expect(check({}).sendable).toBe(true);
  });

  it('1. reply received', () => {
    const v = check({ replyReceivedAt: new Date('2026-10-24T09:00:00Z') });
    expect(v.code).toBe('REPLY_RECEIVED');
  });

  it('2. contact opted out — checked before the arm, because it is the stronger fact', () => {
    expect(check({ contactOptedOut: true }).code).toBe('CONTACT_OPTED_OUT');
    expect(check({ contactOptedOut: true, arm: 'holdout' }).code).toBe('CONTACT_OPTED_OUT');
  });

  it('3. three touches already sent', () => {
    expect(check({ touchCount: 3 }).code).toBe('TOUCH_LIMIT');
    expect(check({ touchCount: 2 }).sendable).toBe(true);
  });

  it('4. less than seven days since the last touch', () => {
    expect(check({ lastTouchAt: new Date('2026-10-20T09:00:00Z') }).code).toBe('RECENT_TOUCH');
    expect(check({ lastTouchAt: new Date('2026-10-18T09:00:00Z') }).sendable).toBe(true);
  });

  it('5. opportunity closed', () => {
    for (const status of ['won', 'lost', 'expired', 'dormant']) {
      expect(check({ opportunityStatus: status }).code).toBe('OPPORTUNITY_CLOSED');
    }
  });

  it('6. holdout arm', () => {
    expect(check({ arm: 'holdout' }).code).toBe('HOLDOUT');
  });

  it('7. workspace suspended or cancelled', () => {
    expect(check({ workspaceStatus: 'canceled' }).code).toBe('WORKSPACE_SUSPENDED');
    expect(check({ workspaceStatus: 'suspended' }).code).toBe('WORKSPACE_SUSPENDED');
  });

  it('8. daily cap reached — the rule from §9 that is not a per-dossier rule', () => {
    expect(check({ sendsToday: 40 }).code).toBe('DAILY_CAP_REACHED');
    expect(check({ sendsToday: 39 }).sendable).toBe(true);
  });
});
