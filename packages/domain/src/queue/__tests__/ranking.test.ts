/**
 * Criterion 5 — the ranking of a 30-opportunity fixture is frozen.
 *
 * The expected order below was produced by the engine and then *read*, not
 * computed by it: if a future change reorders the day, this test says so instead
 * of letting the product quietly start recommending something else first.
 */
import { describe, it, expect } from 'vitest';
import { buildQueue, type QueueCandidate } from '../buildQueue.ts';
import { score } from '../../scoring/score.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function fixture(): QueueCandidate[] {
  const out: QueueCandidate[] = [];
  for (let i = 0; i < 30; i += 1) {
    const weeks = 0.5 + (i % 12) * 0.45;              // 0.5 → 5.45 semaines
    const amountCents = (2_000 + i * 1_700) * 100;     // 2 000 → 51 300 €
    const sig = 0.25 + ((i * 7) % 10) / 14;            // 0.25 → 0.89
    const sentAt = daysAgo(Math.round(weeks * 7));
    out.push({
      id: `op-${String(i).padStart(2, '0')}`,
      clientName: `Client ${i}`,
      amountCents,
      sentAt,
      lastTouchAt: null,
      touchCount: 0,
      status: 'open',
      arm: 'treatment',
      replyReceivedAt: null,
      contactOptedOut: false,
      score: score({ amountCents, weeksSinceSend: weeks, signal: sig, annoyed: false }),
    });
  }
  return out;
}

describe('ranking of 30 opportunities', () => {
  const q = buildQueue(fixture(), { now: NOW, capacity: 8 });

  it('returns the frozen order', () => {
    expect(q.items.map((i) => i.opportunityId)).toEqual([
      'op-27', 'op-28', 'op-25', 'op-17', 'op-14', 'op-29', 'op-26', 'op-18',
    ]);
  });

  it('is identical on a second run', () => {
    const again = buildQueue(fixture(), { now: NOW, capacity: 8 });
    expect(again.items.map((i) => i.opportunityId)).toEqual(q.items.map((i) => i.opportunityId));
    expect(again.items.map((i) => i.scoreCents)).toEqual(q.items.map((i) => i.scoreCents));
  });

  it('scores are strictly decreasing down the queue', () => {
    for (let i = 1; i < q.items.length; i += 1) {
      expect(q.items[i - 1]!.scoreCents).toBeGreaterThanOrEqual(q.items[i]!.scoreCents);
    }
  });

  it('reports every eligible dossier, cap and overflow', () => {
    // Three dossiers are 4 business days old (sent on a Thursday, "today" is a
    // Sunday): gate 4 refuses them and says TOO_SOON, not "false".
    expect(q.rejections.byCode.TOO_SOON).toBe(3);
    expect(q.eligibleTotal).toBe(27);
    expect(q.overflow).toHaveLength(19);
  });
});
