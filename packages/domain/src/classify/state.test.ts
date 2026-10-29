import { describe, it, expect } from 'vitest';
import { classify, SILENCE_THRESHOLD_DAYS, topValueThreshold, type ClassifyInput } from './state.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    amountCents: 1_240_000,
    stage: 'proposal_sent',
    sentAt: daysAgo(20),
    lastTouchAt: daysAgo(12),
    touchCount: 1,
    replyReceivedAt: null,
    status: 'open',
    now: NOW,
    ...over,
  };
}

describe('state 1 — no_reply', () => {
  it('flags a dossier never followed up', () => {
    const c = classify(input({ touchCount: 0, lastTouchAt: null }));
    expect(c.state).toBe('no_reply');
    expect(c.reasonKey).toBe('never_followed_up');
    expect(c.params.days).toBe(20);
  });

  it('wins over every other rule (priority)', () => {
    const c = classify(input({ touchCount: 0, lastTouchAt: null, stage: 'verbal_yes', sentAt: daysAgo(60) }));
    expect(c.state).toBe('no_reply');
  });
});

describe('state 2 — late_action', () => {
  it('flags a planned action whose date has passed', () => {
    const c = classify(input({ expectedActionAt: daysAgo(3) }));
    expect(c.state).toBe('late_action');
    expect(c.reasonKey).toBe('overdue_action');
    expect(c.params.days).toBe(3);
  });

  it('does not fire when the planned action is in the future', () => {
    const c = classify(input({ expectedActionAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() }));
    expect(c.state).not.toBe('late_action');
  });
});

describe('state 3 — abnormal_silence, with thresholds', () => {
  it('proposal_sent: silent 10 days fires', () => {
    const c = classify(input({ stage: 'proposal_sent', lastTouchAt: daysAgo(10) }));
    expect(c.state).toBe('abnormal_silence');
    expect(c.params.days).toBe(10);
  });

  it('proposal_sent: silent 9 days does not fire', () => {
    const c = classify(input({ stage: 'proposal_sent', lastTouchAt: daysAgo(9) }));
    expect(c.state).toBe('watch');
  });

  it('followup_1: silent 7 days fires', () => {
    expect(classify(input({ stage: 'followup_1', lastTouchAt: daysAgo(7) })).state).toBe('abnormal_silence');
  });

  it('followup_1: silent 6 days does not fire', () => {
    expect(classify(input({ stage: 'followup_1', lastTouchAt: daysAgo(6) })).state).toBe('watch');
  });

  it('verbal_yes is the most impatient: 3 days', () => {
    expect(classify(input({ stage: 'verbal_yes', lastTouchAt: daysAgo(3) })).state).toBe('abnormal_silence');
    expect(classify(input({ stage: 'verbal_yes', lastTouchAt: daysAgo(2) })).state).toBe('watch');
  });

  it('falls back to 10 days for an unknown stage', () => {
    expect(classify(input({ stage: 'weird', lastTouchAt: daysAgo(10) })).state).toBe('abnormal_silence');
  });

  it('exposes a coherent threshold table', () => {
    expect(SILENCE_THRESHOLD_DAYS.verbal_yes!).toBeLessThan(SILENCE_THRESHOLD_DAYS.proposal_sent!);
  });
});

describe('state 4 — watch', () => {
  it('is the default for an active, recently touched dossier', () => {
    const c = classify(input({ lastTouchAt: daysAgo(2), stage: 'negotiation' }));
    expect(c.state).toBe('watch');
  });

  it('says "top 20 %" only when the amount really is in the top 20 %', () => {
    const big = classify(input({
      lastTouchAt: daysAgo(2), stage: 'negotiation', amountCents: 40_000_00,
      topValueThresholdCents: 12_000_00,
    }));
    expect(big.reasonKey).toBe('high_value_watch');

    const small = classify(input({
      lastTouchAt: daysAgo(2), stage: 'negotiation', amountCents: 8_000_00,
      topValueThresholdCents: 12_000_00,
    }));
    expect(small.state).toBe('watch');
    expect(small.reasonKey).toBe('recently_touched');
  });

  it('never calls an answered dossier "high value watch"', () => {
    const c = classify(input({
      status: 'won', replyReceivedAt: daysAgo(1), amountCents: 40_000_00,
      topValueThresholdCents: 12_000_00,
    }));
    expect(c.reasonKey).toBe('recently_touched');
  });
});

describe('closed and answered dossiers', () => {
  it('an answered dossier is never flagged as neglected', () => {
    const c = classify(input({ replyReceivedAt: daysAgo(1), touchCount: 0, lastTouchAt: null }));
    expect(c.state).toBe('watch');
  });

  it('a won dossier is never flagged', () => {
    expect(classify(input({ status: 'won' })).state).toBe('watch');
  });

  it('an expired dossier is never flagged', () => {
    expect(classify(input({ status: 'expired' })).state).toBe('watch');
  });
});

describe('robustness', () => {
  it('accepts Date objects as well as ISO strings', () => {
    const c = classify(input({ sentAt: new Date(NOW.getTime() - 15 * 86_400_000), touchCount: 0, lastTouchAt: null }));
    expect(c.daysSinceSend).toBe(15);
  });

  it('never returns a negative day count (clock skew)', () => {
    const c = classify(input({ sentAt: new Date(NOW.getTime() + 3600_000), touchCount: 0 }));
    expect(c.daysSinceSend).toBe(0);
  });

  it('throws on a missing date rather than silently returning a state', () => {
    expect(() => classify(input({ sentAt: 'garbage' }))).toThrow(/sentAt/);
  });

  it('always returns a localisable reason key', () => {
    const states = [
      input({ touchCount: 0, lastTouchAt: null }),
      input({ expectedActionAt: daysAgo(2) }),
      input({ lastTouchAt: daysAgo(30) }),
      input({ lastTouchAt: daysAgo(1) }),
    ].map((i) => classify(i));
    for (const s of states) expect(s.reasonKey).toMatch(/^(never_followed_up|overdue_action|silent_for|high_value_watch|recently_touched)$/);
  });
});

describe('topValueThreshold', () => {
  it('puts 10 amounts at 8 above the line, 2 below', () => {
    const amounts = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000];
    const t = topValueThreshold(amounts);
    expect(t).toBe(8_000);
    expect(amounts.filter((a) => a >= t)).toHaveLength(3); // 8 000, 9 000, 10 000
  });

  it('is Infinity on an empty portfolio, so nothing is "high value"', () => {
    expect(topValueThreshold([])).toBe(Number.POSITIVE_INFINITY);
  });

  it('ignores zeros and NaN rather than letting them drag the bar down', () => {
    expect(topValueThreshold([0, Number.NaN, 5_000, 10_000])).toBe(10_000);
  });

  it('does not reorder the caller array', () => {
    const amounts = [10_000, 1_000, 5_000];
    topValueThreshold(amounts);
    expect(amounts).toEqual([10_000, 1_000, 5_000]);
  });
});
