/**
 * The seven gates, one test each, plus the seven boundary pairs of the prompt.
 * Every rejection asserts a *named* code: an anonymous `false` would make the
 * empty state of the queue impossible to explain.
 */
import { describe, it, expect } from 'vitest';
import {
  checkEligibility, businessDaysBetween, daysBetween, GATES,
  type EligibilityInput,
} from '../eligibility.ts';
import { buildQueue, clampCapacity, compareCandidates, type QueueCandidate } from '../buildQueue.ts';
import { score } from '../../scoring/score.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const base: EligibilityInput = {
  arm: 'treatment',
  status: 'open',
  touchCount: 0,
  sentAt: day(20),
  lastTouchAt: null,
  replyReceivedAt: null,
  contactOptedOut: false,
};

const check = (patch: Partial<EligibilityInput>, now = NOW) =>
  checkEligibility({ ...base, ...patch }, now);

describe('gate 1 — holdout', () => {
  it('rejects a dossier in the control group', () => {
    const r = check({ arm: 'holdout' });
    expect(r.eligible).toBe(false);
    expect(r.code).toBe('HOLDOUT');
  });
});

describe('gate 2 — status', () => {
  it('rejects anything that is not open', () => {
    for (const status of ['won', 'lost', 'expired', 'dormant']) {
      const r = check({ status });
      expect(r.code).toBe('NOT_OPEN');
    }
  });
});

describe('gate 3 — touch limit', () => {
  it('2 touches pass, 3 touches are refused', () => {
    expect(check({ touchCount: 2, lastTouchAt: day(30) }).eligible).toBe(true);
    const r = check({ touchCount: 3, lastTouchAt: day(30) });
    expect(r.code).toBe('TOUCH_LIMIT');
    expect(GATES.MAX_TOUCHES).toBe(3);
  });
});

describe('gate 4 — five business days since send', () => {
  it('4 business days wait, 5 business days are eligible', () => {
    const sent4 = new Date('2026-10-19T10:00:00Z'); // Monday
    const thu = new Date('2026-10-22T10:00:00Z');   // +3 bd
    const fri = new Date('2026-10-23T10:00:00Z');   // +4 bd
    const mon = new Date('2026-10-26T10:00:00Z');   // +5 bd
    expect(check({ sentAt: sent4 }, fri).code).toBe('TOO_SOON');
    expect(check({ sentAt: sent4 }, mon).eligible).toBe(true);
    expect(check({ sentAt: sent4 }, thu).code).toBe('TOO_SOON');
  });

  it('skips weekends: a Friday send is not old enough on Tuesday morning', () => {
    const friday = new Date('2026-10-16T10:00:00Z');
    const tuesday = new Date('2026-10-20T10:00:00Z');
    expect(businessDaysBetween(friday, tuesday)).toBe(2); // Mon + Tue
    expect(check({ sentAt: friday }, tuesday).code).toBe('TOO_SOON');
  });

  it('skips the workspace holidays', () => {
    const friday = new Date('2026-10-16T10:00:00Z');
    const nextfri = new Date('2026-10-23T10:00:00Z');
    expect(businessDaysBetween(friday, nextfri)).toBe(5);
    expect(businessDaysBetween(friday, nextfri, ['2026-10-19'])).toBe(4);
  });
});

describe('gate 5 — seven days between two touches', () => {
  it('6 days wait, 7 days are eligible', () => {
    expect(check({ touchCount: 1, sentAt: day(40), lastTouchAt: day(6) }).code).toBe('RECENT_TOUCH');
    expect(check({ touchCount: 1, sentAt: day(40), lastTouchAt: day(7) }).eligible).toBe(true);
  });

  it('does not apply to a never-touched dossier', () => {
    expect(daysBetween(day(40), NOW)).toBe(40);
    expect(check({ touchCount: 0, sentAt: day(40), lastTouchAt: null }).eligible).toBe(true);
  });

  it('measures from the send date when the last touch date is unknown', () => {
    // "3 relances" without a date is the normal shape of a CSV export. Refusing
    // these would empty the queue of every imported dossier while telling the
    // user they were "touched less than 7 days ago", which is simply false.
    const r = check({ touchCount: 2, sentAt: day(22), lastTouchAt: null });
    expect(r.eligible).toBe(true);
    expect(r.detail.lastTouchKnown).toBe(false);
    expect(r.detail.daysSinceLastTouch).toBe(22);
  });
});

describe('gate 6 — nobody who answered, nobody who opted out', () => {
  it('rejects a dossier that received a reply', () => {
    const r = check({ replyReceivedAt: day(3) });
    expect(r.code).toBe('REPLIED');
  });

  it('rejects an opted-out contact — and says so before anything else', () => {
    const r = check({ contactOptedOut: true, arm: 'holdout' });
    expect(r.code).toBe('OPTED_OUT');
  });
});

describe('gate 7 — six-week window', () => {
  it('6.0 weeks pass, 6.1 weeks are refused', () => {
    const w6 = new Date(NOW.getTime() - 6 * 7 * 86_400_000);
    const w61 = new Date(NOW.getTime() - 6.1 * 7 * 86_400_000);
    expect(check({ sentAt: w6 }).eligible).toBe(true);
    expect(check({ sentAt: w61 }).code).toBe('WINDOW_CLOSED');
  });
});

describe('detail payload and helpers', () => {
  it('exposes the numbers that produced the decision', () => {
    const r = check({ sentAt: new Date('2026-10-16T10:00:00Z'), lastTouchAt: null });
    expect(r.detail.businessDaysSinceSend).toBe(5);
    expect(r.detail.weeksSinceSend).toBeGreaterThan(1);
  });

  it('clamps the daily capacity to 4–20, default 8', () => {
    expect(clampCapacity(undefined)).toBe(8);
    expect(clampCapacity(2)).toBe(4);
    expect(clampCapacity(50)).toBe(20);
    expect(clampCapacity(12)).toBe(12);
  });

  it('always returns a total order through the final id tie-break', () => {
    const same = { scoreCents: 100, amountCents: 100, sentAt: NOW };
    expect(compareCandidates({ ...same, id: 'a' }, { ...same, id: 'b' })).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------- buildQueue
const candidate = (id: string, amountCents: number, weeks: number, patch: Partial<QueueCandidate> = {}): QueueCandidate => {
  const sentAt = new Date(NOW.getTime() - weeks * 7 * 86_400_000);
  return {
    id, clientName: `Client ${id}`, amountCents, sentAt,
    lastTouchAt: null, touchCount: 0, status: 'open', arm: 'treatment',
    replyReceivedAt: null, contactOptedOut: false,
    score: score({ amountCents, weeksSinceSend: weeks, signal: 0.5, annoyed: false }),
    ...patch,
  };
};

describe('buildQueue', () => {
  it('caps at the daily capacity and reports the overflow', () => {
    const candidates = Array.from({ length: 12 }, (_, i) => candidate(`c${i}`, 10_000_00, 2));
    const q = buildQueue(candidates, { now: NOW, capacity: 5 });
    expect(q.items).toHaveLength(5);
    expect(q.overflow).toHaveLength(7);
    expect(q.eligibleTotal).toBe(12);
    expect(q.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it('counts each rejection by its named reason', () => {
    const q = buildQueue(
      [
        candidate('ok', 10_000_00, 2),
        candidate('hold', 10_000_00, 2, { arm: 'holdout' }),
        candidate('soon', 10_000_00, 0.2),
        candidate('closed', 10_000_00, 7),
        candidate('replied', 10_000_00, 2, { replyReceivedAt: day(1) }),
      ],
      { now: NOW, capacity: 8 },
    );
    expect(q.items).toHaveLength(1);
    expect(q.rejections.byCode.HOLDOUT).toBe(1);
    expect(q.rejections.byCode.TOO_SOON).toBe(1);
    expect(q.rejections.byCode.WINDOW_CLOSED).toBe(1);
    expect(q.rejections.byCode.REPLIED).toBe(1);
    expect(q.rejections.total).toBe(4);
  });

  it('is deterministic: the same fixture gives the same order twice', () => {
    const fixtures = [
      candidate('a', 45_000_00, 2.7), candidate('b', 12_400_00, 2.7),
      candidate('c', 2_100_00, 1.7), candidate('d', 18_300_00, 3.2),
      candidate('e', 9_800_00, 1.0), candidate('f', 14_800_00, 0.4),
    ];
    const first = buildQueue(fixtures, { now: NOW, capacity: 8 }).items.map((i) => i.opportunityId);
    const second = buildQueue(fixtures, { now: NOW, capacity: 8 }).items.map((i) => i.opportunityId);
    expect(first).toEqual(second);
  });
});
