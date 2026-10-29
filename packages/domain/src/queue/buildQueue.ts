/**
 * Ranking and capping — the pure half of the queue.
 *
 * Persistence lives in `packages/db/src/repo/queue.ts` on purpose: the domain
 * package has been IO-free since phase 01, and a `buildQueue` that writes to
 * Postgres could no longer be tested against the golden vectors in a millisecond.
 * The prompt names the file `buildQueue`; the split is documented in
 * DECISIONS.md #12.
 */
import { checkEligibility, type EligibilityInput, type RejectionCode } from './eligibility.ts';
import type { ScoreResult } from '../scoring/score.ts';

export interface QueueCandidate extends EligibilityInput {
  id: string;
  clientName: string;
  amountCents: number;
  sentAt: Date;
  lastTouchAt: Date | null;
  score: ScoreResult;
}

export interface QueueItem {
  opportunityId: string;
  rank: number;
  scoreCents: number;
  expectedValueCents: number;
  pReply: number;
  pConvert: number;
  urgency: number;
  factors: ScoreResult['factors'];
  engineVersion: string;
}

export interface QueueRejections {
  byCode: Record<RejectionCode, number>;
  /** How many dossiers each gate removed, in the order of §6.4. */
  total: number;
}

export interface BuildQueueResult {
  items: QueueItem[];
  /** Eligible dossiers that did not fit the daily capacity. */
  overflow: { opportunityId: string; scoreCents: number }[];
  rejections: QueueRejections;
  eligibleTotal: number;
}

export const DEFAULT_DAILY_CAPACITY = 8;
export const MIN_DAILY_CAPACITY = 4;
export const MAX_DAILY_CAPACITY = 20;

export function clampCapacity(capacity: number | null | undefined): number {
  const c = Math.round(capacity ?? DEFAULT_DAILY_CAPACITY);
  if (!Number.isFinite(c)) return DEFAULT_DAILY_CAPACITY;
  return Math.min(MAX_DAILY_CAPACITY, Math.max(MIN_DAILY_CAPACITY, c));
}

/**
 * Deterministic order: score desc, then amount desc, then oldest sent first.
 * The last two tie-breakers exist so that two identical scores never swap places
 * between two generations — a queue that reorders daily for no reason destroys
 * the user's trust in the ranking.
 */
export function compareCandidates(
  a: { scoreCents: number; amountCents: number; sentAt: Date; id: string },
  b: { scoreCents: number; amountCents: number; sentAt: Date; id: string },
): number {
  if (b.scoreCents !== a.scoreCents) return b.scoreCents - a.scoreCents;
  if (b.amountCents !== a.amountCents) return b.amountCents - a.amountCents;
  const byDate = a.sentAt.getTime() - b.sentAt.getTime();
  if (byDate !== 0) return byDate;
  return a.id.localeCompare(b.id); // final tie-break: total order, always
}

export function buildQueue(
  candidates: readonly QueueCandidate[],
  options: { now: Date; capacity?: number | null; holidays?: readonly string[] },
): BuildQueueResult {
  const capacity = clampCapacity(options.capacity);
  const byCode = Object.fromEntries(
    [
      'HOLDOUT', 'NOT_OPEN', 'TOUCH_LIMIT', 'TOO_SOON', 'RECENT_TOUCH',
      'REPLIED', 'OPTED_OUT', 'WINDOW_CLOSED',
    ].map((c) => [c, 0]),
  ) as Record<RejectionCode, number>;

  let rejectedTotal = 0;
  const eligible: QueueCandidate[] = [];

  for (const c of candidates) {
    const verdict = checkEligibility(c, options.now, options.holidays ?? []);
    if (verdict.eligible) {
      eligible.push(c);
    } else {
      byCode[verdict.code!] += 1;
      rejectedTotal += 1;
    }
  }

  eligible.sort((a, b) =>
    compareCandidates(
      { scoreCents: a.score.scoreCents, amountCents: a.amountCents, sentAt: a.sentAt, id: a.id },
      { scoreCents: b.score.scoreCents, amountCents: b.amountCents, sentAt: b.sentAt, id: b.id },
    ),
  );

  const items: QueueItem[] = eligible.slice(0, capacity).map((c, i) => ({
    opportunityId: c.id,
    rank: i + 1,
    scoreCents: c.score.scoreCents,
    expectedValueCents: c.score.expectedValueCents,
    pReply: c.score.pReply,
    pConvert: c.score.pConvert,
    urgency: c.score.urgency,
    factors: c.score.factors,
    engineVersion: c.score.engineVersion,
  }));

  return {
    items,
    overflow: eligible.slice(capacity).map((c) => ({
      opportunityId: c.id,
      scoreCents: c.score.scoreCents,
    })),
    rejections: { byCode, total: rejectedTotal },
    eligibleTotal: eligible.length,
  };
}
