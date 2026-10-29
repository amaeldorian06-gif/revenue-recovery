import {
  parseAmountToCents,
  parseDate,
  detectDateConvention,
  normalizeStage,
  cleanText,
  normalizeEmail,
  parseDayCount,
  type Stage,
} from './normalize.ts';
import { detectMapping, isMappingUsable, type Mapping, type TargetField } from './detect.ts';

/**
 * The import pipeline: pure, no IO, no clock. Given raw rows and a mapping it
 * returns what to create, what to update, and every row it refused — with the
 * reason. A silent coercion here would poison every downstream metric.
 */

export type Row = Record<string, unknown>;

export interface NormalisedOpportunity {
  externalRef: string | null;
  clientName: string;
  title: string | null;
  amountCents: number;
  currency: string;
  stage: Stage;
  sentAt: string; // ISO
  lastTouchAt: string | null;
  touchCount: number;
  contactEmail: string | null;
  raw: Row;
}

export interface SkippedRow {
  rowIndex: number;
  reason:
    | 'missing_client'
    | 'missing_amount'
    | 'missing_sent_at'
    | 'invalid_amount'
    | 'invalid_date'
    | 'future_sent_at'
    | 'too_old'
    | 'duplicate_in_file';
  detail?: string;
}

export interface ExistingOpportunity {
  id: string;
  externalRef: string | null;
  clientName: string;
  amountCents: number;
  sentAt: string;
}

export interface ImportResult {
  toCreate: NormalisedOpportunity[];
  toUpdate: { id: string; patch: Partial<NormalisedOpportunity> }[];
  skipped: SkippedRow[];
  stats: {
    rows: number;
    valid: number;
    created: number;
    updated: number;
    skipped: number;
    duplicatesInFile: number;
  };
  dateConvention: 'DMY' | 'MDY';
}

const MAX_AGE_DAYS = 548; // 18 months

export function cell(row: Row, mapping: Mapping[], field: TargetField): unknown {
  const m = mapping.find((x) => x.field === field);
  if (!m?.column) return undefined;
  return row[m.column];
}

/** Dedupe key, identical on both sides of the comparison. */
export function dedupeKey(o: {
  externalRef: string | null;
  clientName: string;
  amountCents: number;
  sentAt: string;
}): string {
  if (o.externalRef) return `ref:${o.externalRef.trim().toLowerCase()}`;
  const day = o.sentAt.slice(0, 10);
  const name = o.clientName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return `nat:${name}:${o.amountCents}:${day}`;
}

export interface ImportOptions {
  mapping: Mapping[];
  existing: ExistingOpportunity[];
  /** Reference "now"; injected so the function stays pure and testable. */
  now: Date;
  holdoutRate: number;
}

export function normaliseRow(
  row: Row,
  mapping: Mapping[],
  convention: 'DMY' | 'MDY',
  now: Date,
): { ok: true; value: NormalisedOpportunity } | { ok: false; skipped: Omit<SkippedRow, 'rowIndex'> } {
  const clientName = cleanText(cell(row, mapping, 'client_name'), 120);
  if (!clientName) return { ok: false, skipped: { reason: 'missing_client' } };

  const rawAmount = cell(row, mapping, 'amount_cents');
  const amount = parseAmountToCents(rawAmount);
  if (amount.cents === null) {
    const reason = amount.reason === 'empty' ? 'missing_amount' : 'invalid_amount';
    return { ok: false, skipped: { reason, detail: String(rawAmount ?? '') } };
  }

  const rawDate = cell(row, mapping, 'sent_at');
  const date = parseDate(rawDate, convention);
  if (!date.iso) {
    const reason = date.reason === 'empty' ? 'missing_sent_at' : 'invalid_date';
    return { ok: false, skipped: { reason, detail: String(rawDate ?? '') } };
  }
  const sentAtMs = new Date(date.iso).getTime();
  if (sentAtMs > now.getTime() + 24 * 3600 * 1000) {
    return { ok: false, skipped: { reason: 'future_sent_at', detail: date.iso } };
  }
  if (now.getTime() - sentAtMs > MAX_AGE_DAYS * 24 * 3600 * 1000) {
    return { ok: false, skipped: { reason: 'too_old', detail: date.iso } };
  }

  const lastTouchRaw = cell(row, mapping, 'last_touch_at');
  const lastTouch = lastTouchRaw ? parseDate(lastTouchRaw, convention) : { iso: null };

  const touches = parseDayCount(cell(row, mapping, 'touch_count'));

  return {
    ok: true,
    value: {
      externalRef: cleanText(cell(row, mapping, 'external_ref'), 80),
      clientName,
      title: cleanText(cell(row, mapping, 'title'), 200),
      amountCents: amount.cents,
      currency: 'EUR',
      stage: normalizeStage(cell(row, mapping, 'stage')).stage,
      sentAt: date.iso,
      lastTouchAt: lastTouch.iso,
      touchCount: Math.min(Math.max(touches ?? 0, 0), 3),
      contactEmail: normalizeEmail(cell(row, mapping, 'contact_email')),
      raw: row,
    },
  };
}

/**
 * The whole import, as a pure function. `assignArm` is injected so the caller
 * decides the RNG (crypto in production, seeded in tests) — the function itself
 * never touches randomness, which is what makes the arm-protection test possible.
 */
export function importPipeline(
  rows: Row[],
  opts: ImportOptions & { assignArm: () => 'treatment' | 'holdout' },
): ImportResult & { arms: Map<string, 'treatment' | 'holdout'> } {
  const convention = detectDateConvention(rows.map((r) => cell(r, opts.mapping, 'sent_at')));

  const existingByKey = new Map<string, ExistingOpportunity>();
  for (const e of opts.existing) existingByKey.set(dedupeKey(e), e);

  const toCreate: NormalisedOpportunity[] = [];
  const toUpdate: { id: string; patch: Partial<NormalisedOpportunity> }[] = [];
  const skipped: SkippedRow[] = [];
  const seenInFile = new Set<string>();
  const arms = new Map<string, 'treatment' | 'holdout'>();
  let duplicatesInFile = 0;

  // The arm is decided once per natural key, at creation time, and never again.
  const armForKey = (key: string): 'treatment' | 'holdout' => {
    const known = arms.get(key);
    if (known) return known;
    const arm = opts.assignArm();
    arms.set(key, arm);
    return arm;
  };

  rows.forEach((row, i) => {
    const parsed = normaliseRow(row, opts.mapping, convention, opts.now);
    if (!parsed.ok) {
      skipped.push({ rowIndex: i, ...parsed.skipped });
      return;
    }
    const value = parsed.value;
    const key = dedupeKey(value);

    if (seenInFile.has(key)) {
      duplicatesInFile += 1;
      skipped.push({ rowIndex: i, reason: 'duplicate_in_file', detail: key });
      return;
    }
    seenInFile.add(key);

    const existing = existingByKey.get(key);
    if (existing) {
      // Update mutable fields only. The arm lives on the database row and is
      // protected by a trigger; it is never part of a patch.
      toUpdate.push({
        id: existing.id,
        patch: {
          clientName: value.clientName,
          title: value.title ?? undefined,
          amountCents: value.amountCents,
          stage: value.stage,
          sentAt: value.sentAt,
          lastTouchAt: value.lastTouchAt ?? undefined,
          contactEmail: value.contactEmail ?? undefined,
        },
      });
      return;
    }

    armForKey(key);
    toCreate.push(value);
  });

  return {
    toCreate,
    toUpdate,
    skipped,
    arms,
    dateConvention: convention,
    stats: {
      rows: rows.length,
      valid: toCreate.length + toUpdate.length,
      created: toCreate.length,
      updated: toUpdate.length,
      skipped: skipped.length,
      duplicatesInFile,
    },
  };
}

export { detectMapping, isMappingUsable };
