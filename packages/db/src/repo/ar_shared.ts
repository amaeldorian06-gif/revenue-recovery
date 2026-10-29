import { ENGINE_VERSION, type Factor } from '../../../domain/src/scoring/score.ts';

/**
 * AR shared contract — the DOCUMENTED rules of the Accounts Receivable view.
 * No invented fields: the schema has no due-date column and no payment record,
 * so every money label below is defined against age-since-sent, and the UI
 * wording must follow (never "retard" alone, never "encaissé" for a won deal).
 */

/** Standard payment term assumed by the "échu" rule (documented, not invented data). */
export const PAYMENT_TERM_DAYS = 30;

/**
 * Bands on the priority index (0-100, normalized inside the workspace against
 * the best-scoring client). This index is a RELANCE priority computed by the
 * existing scoring engine — it is NOT a default/payment-risk probability:
 * the schema holds no payment data, so none may be implied.
 */
export const PRIORITY_BANDS = { high: 66, mid: 33 } as const;

export const DAY = 86_400_000;

export { ENGINE_VERSION };
export type { Factor };

export interface ArFilters {
  q?: string;
  status: 'open' | 'won' | 'lost' | 'all';
  ageMin?: number;
  ageMax?: number;
  /** Band of the priority index — a relance priority, not a default risk. */
  priority?: 'high' | 'mid' | 'low';
  view?: 'all' | 'priority_high' | 'overdue90' | 'stale';
  sort: 'amount_desc' | 'amount_asc' | 'age_desc' | 'priority_desc' | 'name_asc';
  page: number;
  /** 0 = no pagination (CSV export of the whole filtered set). */
  pageSize: number;
}

export interface ArOpportunityLine {
  id: string;
  title: string | null;
  amountCents: number;
  ageDays: number;
  stage: string;
  touchCount: number;
  scoreCents: number;
  priorityIndex: number;
}

export interface ArRow {
  client: string;
  openCount: number;
  outstandingCents: number;
  overdueCents: number;
  oldestAgeDays: number;
  priorityBand: 'high' | 'mid' | 'low';
  /** Workspace-normalized relance index of the best line (0-100). */
  priorityIndex: number;
  /** Best line score of the client (engine's expected recovery value). */
  priorityScoreCents: number;
  /** Explanation factors of the best line — rendered by the UI as-is. */
  factors: Factor[];
  engineVersion: string;
  lastTouchAt: string | null;
  lines: ArOpportunityLine[];
}

export interface ArKpis {
  outstandingCents: number;
  overdueCents: number;
  /** Outstanding of clients in the high priority band (relance priority). */
  priorityHighCents: number;
  openCount: number;
  clientCount: number;
  /** Deals marked won with sent_at in the last 30 days — NEVER "cash in". */
  wonClosed30dCents: number;
  /** Always null: no due-date/payment data → UI must show "données insuffisantes". */
  dsoDays: null;
}

export interface ArSnapshot {
  kpis: ArKpis;
  total: number;
  page: number;
  pageSize: number;
  rows: ArRow[];
  computedAt: string;
  engineVersion: string;
}
