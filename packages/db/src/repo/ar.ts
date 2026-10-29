import { loadCandidates } from './queue.ts';
import { score } from '../../../domain/src/scoring/score.ts';
import { STAGE_SCORE } from '../../../domain/src/scoring/signals.ts';

/**
 * Accounts Receivable (AR) — the per-CLIENT financial view built strictly on
 * existing data (opportunities = créances) and the EXISTING scoring engine.
 * Rules and constants live in ar_shared.ts (documented there). The priority
 * index reuses the queue's score: it ranks what is worth chasing NOW, it does
 * not estimate a payment default.
 */
import {
  PAYMENT_TERM_DAYS, PRIORITY_BANDS, DAY, ENGINE_VERSION,
  type ArFilters, type ArRow, type ArSnapshot, type ArKpis, type ArOpportunityLine,
} from './ar_shared.ts';
export type { ArFilters, ArRow, ArSnapshot, ArKpis, ArOpportunityLine };
export { arToCsv } from './ar_shared_csv.ts';
export { PAYMENT_TERM_DAYS, PRIORITY_BANDS };
import { signal as clientSignal } from '../../../domain/src/scoring/signals.ts';

function band(priority: number): 'high' | 'mid' | 'low' {
  if (priority >= PRIORITY_BANDS.high) return 'high';
  if (priority >= PRIORITY_BANDS.mid) return 'mid';
  return 'low';
}

function matchesView(row: ArRow, filters: ArFilters, nowMs: number): boolean {
  switch (filters.view) {
    case 'priority_high': return row.priorityBand === 'high' && row.openCount > 0;
    case 'overdue90': return row.oldestAgeDays >= 90 && row.overdueCents > 0;
    case 'stale':
      if (row.lastTouchAt === null) return true;
      return nowMs - new Date(row.lastTouchAt).getTime() > 45 * DAY;
    default: return true;
  }
}

function matchesFilters(row: ArRow, filters: ArFilters, nowMs: number): boolean {
  if (filters.q) {
    const q = filters.q.toLowerCase();
    if (!row.client.toLowerCase().includes(q)
        && !row.lines.some((l) => (l.title ?? '').toLowerCase().includes(q))) {
      return false;
    }
  }
  if (filters.ageMin !== undefined && row.oldestAgeDays < filters.ageMin) return false;
  if (filters.ageMax !== undefined && row.oldestAgeDays > filters.ageMax) return false;
  if (filters.priority && row.priorityBand !== filters.priority) return false;
  return matchesView(row, filters, nowMs);
}

function sortRows(rows: ArRow[], sort: ArFilters['sort']): ArRow[] {
  const by = {
    amount_desc: (a: ArRow, b: ArRow) => b.outstandingCents - a.outstandingCents,
    amount_asc: (a: ArRow, b: ArRow) => a.outstandingCents - b.outstandingCents,
    age_desc: (a: ArRow, b: ArRow) => b.oldestAgeDays - a.oldestAgeDays,
    priority_desc: (a: ArRow, b: ArRow) =>
      b.priorityScoreCents - a.priorityScoreCents || b.outstandingCents - a.outstandingCents,
    name_asc: (a: ArRow, b: ArRow) => a.client.localeCompare(b.client, 'fr'),
  }[sort];
  return [...rows].sort(by);
}

/** Build the AR snapshot for a workspace. Filters/sort/pagination apply to CLIENT rows. */
export async function arSnapshot(
  db: import('../client.ts').Db,
  workspaceId: string,
  now: Date,
  filters: ArFilters,
): Promise<ArSnapshot> {
  const nowMs = now.getTime();
  const candidates = await loadCandidates(db, workspaceId, now);

  // Score every opportunity with the queue engine (same inputs). OPEN lines
  // feed the AR money; every status feeds the per-client behavioural signals.
  interface Scored {
    r: (typeof candidates)[number];
    s: ReturnType<typeof score>;
    ageDays: number;
  }
  const scored: Scored[] = candidates.map((r) => {
    const weeks = Math.max(0, (nowMs - new Date(r.sentAt).getTime()) / (7 * DAY));
    const sig = clientSignal({
      opens14d: r.opens14d,
      replyHistoryRate: r.replyRate,
      wonDealsWithClient: r.wonDeals,
      stage: r.stage,
    });
    const s = score({
      amountCents: r.amountCents,
      weeksSinceSend: weeks,
      signal: sig.value,
      annoyed: r.touchCount >= 3,
      context: {
        opens14d: r.opens14d,
        stage: r.stage,
        stageScore: STAGE_SCORE[r.stage] ?? STAGE_SCORE.other,
        replyHistoryRate: r.replyRate,
      },
    });
    return { r, s, ageDays: Math.floor((nowMs - new Date(r.sentAt).getTime()) / DAY) };
  });

  // Aggregate per client (case-insensitive key), OPEN lines only for the money.
  const groups = new Map<string, {
    display: string;
    lines: ArOpportunityLine[];
    outstanding: number; overdue: number; oldest: number;
    top: { scoreCents: number; factors: ReturnType<typeof score>['factors'] } | null;
    lastTouch: string | null;
    statuses: Set<string>;
    /** (sent_at ms, id) of the encounter that decided the displayed casing. */
    dispAt: number; dispId: string;
  }>();
  for (const { r, s, ageDays } of scored) {
    const key = r.clientName.toLowerCase();
    let g = groups.get(key);
    if (!g) {
      g = { display: r.clientName, lines: [], outstanding: 0, overdue: 0, oldest: 0, top: null, lastTouch: null, statuses: new Set(), dispAt: -1, dispId: '' };
      groups.set(key, g);
    }
    // Displayed casing = MOST RECENT encounter (deterministic across drivers:
    // sent_at desc, then id as the tie-break — never the row order).
    const at = new Date(r.sentAt).getTime();
    if (at > g.dispAt || (at === g.dispAt && r.id > g.dispId)) {
      g.display = r.clientName; g.dispAt = at; g.dispId = r.id;
    }
    g.statuses.add(r.status);
    if (r.lastTouchAt && (!g.lastTouch || r.lastTouchAt > g.lastTouch)) g.lastTouch = r.lastTouchAt;
    if (r.status !== 'open') continue;
    g.lines.push({
      id: r.id, title: r.title, amountCents: r.amountCents, ageDays,
      stage: r.stage, touchCount: r.touchCount, scoreCents: s.scoreCents,
      priorityIndex: 0,
    });
    g.outstanding += r.amountCents;
    if (ageDays > PAYMENT_TERM_DAYS) g.overdue += r.amountCents;
    if (ageDays > g.oldest) g.oldest = ageDays;
    if (!g.top || s.scoreCents > g.top.scoreCents) g.top = { scoreCents: s.scoreCents, factors: s.factors };
  }

  // Normalization base: the best client score of the WHOLE workspace.
  const maxScore = Math.max(1, ...[...groups.values()].map((g) => g.top?.scoreCents ?? 0));

  const allRows: ArRow[] = [];
  const closedOnly: ArRow[] = [];
  for (const g of groups.values()) {
    if (g.lines.length === 0) {
      // Client with only closed lines: shown for status 'won'/'lost'/'all',
      // never in the open money view.
      if (g.statuses.size === 1 && (g.statuses.has('won') || g.statuses.has('lost'))) {
        closedOnly.push({
          client: g.display,
          openCount: 0,
          outstandingCents: 0,
          overdueCents: 0,
          oldestAgeDays: 0,
          priorityBand: 'low',
          priorityIndex: 0,
          priorityScoreCents: 0,
          factors: [],
          engineVersion: ENGINE_VERSION,
          lastTouchAt: g.lastTouch,
          lines: [],
        });
      }
      continue;
    }
    const topScore = g.top?.scoreCents ?? 0;
    const priority = Math.round((100 * topScore) / maxScore);
    for (const l of g.lines) l.priorityIndex = Math.round((100 * l.scoreCents) / maxScore);
    g.lines.sort((a, b) => b.scoreCents - a.scoreCents);
    allRows.push({
      client: g.display,
      openCount: g.lines.length,
      outstandingCents: g.outstanding,
      overdueCents: g.overdue,
      oldestAgeDays: g.oldest,
      priorityBand: band(priority),
      priorityIndex: priority,
      priorityScoreCents: topScore,
      factors: g.top?.factors ?? [],
      engineVersion: ENGINE_VERSION,
      lastTouchAt: g.lastTouch,
      lines: g.lines,
    });
  }

  // KPIs are computed on the WHOLE perimeter (every client with open lines),
  // never on the filtered slice: the header answers "where does the money
  // stand" regardless of what the user is currently looking at.
  let outstanding = 0, overdue = 0, priorityHigh = 0, openCount = 0;
  for (const row of allRows) {
    outstanding += row.outstandingCents;
    overdue += row.overdueCents;
    openCount += row.openCount;
    if (row.priorityBand === 'high') priorityHigh += row.outstandingCents;
  }
  const won30 = scored
    .filter(({ r }) => r.status === 'won' && nowMs - new Date(r.sentAt).getTime() <= 30 * DAY)
    .reduce((sum, { r }) => sum + r.amountCents, 0);
  const kpis: ArKpis = {
    outstandingCents: outstanding,
    overdueCents: overdue,
    priorityHighCents: priorityHigh,
    openCount,
    clientCount: allRows.length,
    wonClosed30dCents: won30,
    dsoDays: null,
  };

  // Then the user's slice: status selection, filters, sort, pagination.
  let rows: ArRow[];
  if (filters.status === 'won' || filters.status === 'lost') {
    // status 'won' / 'lost': clients whose opportunities are ALL in that
    // status (documented semantics — a mixed client stays in the open view).
    rows = closedOnly;
  } else if (filters.status === 'all') {
    rows = [...allRows, ...closedOnly];
  } else {
    rows = allRows;
  }
  rows = rows.filter((row) => matchesFilters(row, filters, nowMs));
  rows = sortRows(rows, filters.sort);

  const total = rows.length;
  const page = Math.max(1, filters.page);
  const pageSize = filters.pageSize > 0 ? filters.pageSize : total;
  const paged = rows.slice((page - 1) * pageSize, page * pageSize);

  return {
    kpis,
    total, page,
    pageSize: filters.pageSize > 0 ? filters.pageSize : total,
    rows: paged,
    computedAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
  };
}
