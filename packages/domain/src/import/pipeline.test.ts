import { describe, it, expect } from 'vitest';
import { importPipeline, dedupeKey, normaliseRow, type ExistingOpportunity } from './pipeline.ts';
import { detectMapping, isMappingUsable } from './detect.ts';
import type { Mapping } from './detect.ts';

const NOW = new Date('2026-10-25T09:00:00Z');

const HEADERS = ['N° devis', 'Client', 'Objet', 'Montant HT', 'Date envoi', 'Stade', 'Nb relances'];

const mapping: Mapping[] = [
  { field: 'external_ref', column: 'N° devis', confidence: 0.95 },
  { field: 'client_name', column: 'Client', confidence: 0.95 },
  { field: 'title', column: 'Objet', confidence: 0.95 },
  { field: 'amount_cents', column: 'Montant HT', confidence: 0.95 },
  { field: 'sent_at', column: 'Date envoi', confidence: 0.95 },
  { field: 'stage', column: 'Stade', confidence: 0.95 },
  { field: 'touch_count', column: 'Nb relances', confidence: 0.9 },
  { field: 'last_touch_at', column: null, confidence: 0 },
  { field: 'contact_email', column: null, confidence: 0 },
];

function row(o: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    'N° devis': 'D-1001',
    Client: 'Atelier Merlot',
    Objet: 'Refonte du site vitrine',
    'Montant HT': '12 400 € HT',
    'Date envoi': '06/10/2026',
    Stade: 'Proposition envoyée',
    'Nb relances': '0',
    ...o,
  };
}

const alwaysTreatment = () => 'treatment' as const;

describe('column detection', () => {
  it('detects every field of a typical French export', () => {
    const m = detectMapping(HEADERS);
    const byField = Object.fromEntries(m.map((x) => [x.field, x]));
    expect(byField.client_name!.column).toBe('Client');
    expect(byField.title!.column).toBe('Objet');
    expect(byField.amount_cents!.column).toBe('Montant HT');
    expect(byField.sent_at!.column).toBe('Date envoi');
    expect(byField.stage!.column).toBe('Stade');
    expect(byField.touch_count!.column).toBe('Nb relances');
    expect(byField.external_ref!.column).toBe('N° devis');
  });

  it('returns a confidence per field and asks when it is unsure', () => {
    const m = detectMapping(['Client', 'Montant', 'Date', 'Colonne A']);
    const byField = Object.fromEntries(m.map((x) => [x.field, x]));
    expect(byField.client_name!.confidence).toBeGreaterThan(0.6);
    expect(byField.amount_cents!.confidence).toBeGreaterThan(0.6);
    expect(byField.title!.column).toBeNull();
    expect(byField.title!.confidence).toBe(0);
  });

  it('never assigns one column to two fields', () => {
    const m = detectMapping(['Email contact', 'Client', 'Montant', 'Date']);
    const used = m.filter((x) => x.column !== null).map((x) => x.column);
    expect(new Set(used).size).toBe(used.length);
  });

  it('flags an English header set just as well', () => {
    const m = detectMapping(['Quote ID', 'Company', 'Amount', 'Sent date', 'Stage']);
    const byField = Object.fromEntries(m.map((x) => [x.field, x]));
    expect(byField.client_name!.column).toBe('Company');
    expect(byField.amount_cents!.column).toBe('Amount');
  });

  it('reports the missing required fields', () => {
    const res = isMappingUsable(detectMapping(['Client', 'Objet']));
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(['amount_cents', 'sent_at']);
  });

  it('accepts a mapping with all required fields', () => {
    expect(isMappingUsable(detectMapping(HEADERS)).ok).toBe(true);
  });
});

describe('row normalisation', () => {
  it('normalises a clean row', () => {
    const r = normaliseRow(row(), mapping, 'DMY', NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      externalRef: 'D-1001',
      clientName: 'Atelier Merlot',
      amountCents: 1_240_000,
      stage: 'proposal_sent',
      sentAt: '2026-10-06T00:00:00.000Z',
      touchCount: 0,
    });
  });

  it('refuses a row without a client', () => {
    const r = normaliseRow(row({ Client: '   ' }), mapping, 'DMY', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skipped.reason).toBe('missing_client');
  });

  it('refuses a zero amount', () => {
    const r = normaliseRow(row({ 'Montant HT': '0' }), mapping, 'DMY', NOW);
    if (!r.ok) expect(r.skipped.reason).toBe('invalid_amount');
    else throw new Error('should have been skipped');
  });

  it('refuses a missing amount', () => {
    const r = normaliseRow(row({ 'Montant HT': '' }), mapping, 'DMY', NOW);
    if (!r.ok) expect(r.skipped.reason).toBe('missing_amount');
  });

  it('refuses a future date', () => {
    const r = normaliseRow(row({ 'Date envoi': '01/01/2027' }), mapping, 'DMY', NOW);
    if (!r.ok) expect(r.skipped.reason).toBe('future_sent_at');
    else throw new Error('should have been skipped');
  });

  it('refuses a dossier older than 18 months', () => {
    const r = normaliseRow(row({ 'Date envoi': '01/01/2024' }), mapping, 'DMY', NOW);
    if (!r.ok) expect(r.skipped.reason).toBe('too_old');
    else throw new Error('should have been skipped');
  });

  it('clamps the touch count to the 0–3 domain', () => {
    const r = normaliseRow(row({ 'Nb relances': '7' }), mapping, 'DMY', NOW);
    if (r.ok) expect(r.value.touchCount).toBe(3);
  });
});

describe('dedupe key', () => {
  it('prefers the external reference', () => {
    expect(dedupeKey({ externalRef: 'D-1001', clientName: 'A', amountCents: 1, sentAt: '2026-10-06' }))
      .toBe('ref:d-1001');
  });
  it('falls back to client + amount + day, accent and case insensitive', () => {
    const a = dedupeKey({ externalRef: null, clientName: 'Atelier MéRlot', amountCents: 1240000, sentAt: '2026-10-06T00:00:00Z' });
    const b = dedupeKey({ externalRef: null, clientName: 'atelier merlot', amountCents: 1240000, sentAt: '2026-10-06T18:00:00Z' });
    expect(a).toBe(b);
  });
  it('separates two dossiers for the same client on different days', () => {
    const a = dedupeKey({ externalRef: null, clientName: 'A', amountCents: 1, sentAt: '2026-10-06' });
    const b = dedupeKey({ externalRef: null, clientName: 'A', amountCents: 1, sentAt: '2026-10-07' });
    expect(a).not.toBe(b);
  });
});

describe('import pipeline — the acceptance criteria', () => {
  it('creates every valid row on a first import', () => {
    const rows = [row(), row({ 'N° devis': 'D-1002', Client: 'Studio Kamba' })];
    const res = importPipeline(rows, { mapping, existing: [], now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    expect(res.stats).toMatchObject({ rows: 2, created: 2, updated: 0, skipped: 0 });
  });

  it('reports every skipped row with a reason', () => {
    const rows = [row(), row({ 'N° devis': 'D-1002', Client: '' }), row({ 'N° devis': 'D-1003', 'Montant HT': 'sur devis' })];
    const res = importPipeline(rows, { mapping, existing: [], now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    expect(res.stats.skipped).toBe(2);
    expect(res.skipped.map((s) => s.reason)).toEqual(['missing_client', 'invalid_amount']);
    expect(res.skipped.map((s) => s.rowIndex)).toEqual([1, 2]);
  });

  it('CRITICAL: importing the same file twice creates nothing the second time', () => {
    const rows = [row(), row({ 'N° devis': 'D-1002', Client: 'Studio Kamba' })];
    const first = importPipeline(rows, { mapping, existing: [], now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    expect(first.stats.created).toBe(2);

    const existing: ExistingOpportunity[] = first.toCreate.map((o, i) => ({
      id: `id-${i}`,
      externalRef: o.externalRef,
      clientName: o.clientName,
      amountCents: o.amountCents,
      sentAt: o.sentAt,
    }));
    const second = importPipeline(rows, { mapping, existing, now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    expect(second.stats.created).toBe(0);
    expect(second.stats.updated).toBe(2);
  });

  it('CRITICAL: a re-import never produces a patch containing the arm', () => {
    const rows = [row()];
    const first = importPipeline(rows, { mapping, existing: [], now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    const existing: ExistingOpportunity[] = [{ id: 'x', externalRef: 'D-1001', clientName: 'Atelier Merlot', amountCents: 1_240_000, sentAt: '2026-10-06T00:00:00.000Z' }];
    const second = importPipeline([row({ 'Montant HT': '15 000 €' })], { mapping, existing, now: NOW, holdoutRate: 0.2, assignArm: () => 'holdout' });
    expect(second.toUpdate).toHaveLength(1);
    expect(Object.keys(second.toUpdate[0]!.patch)).not.toContain('arm');
    // The amount is updated, the arm decision is untouched.
    expect(second.toUpdate[0]!.patch.amountCents).toBe(1_500_000);
    expect(first.toCreate[0]!.amountCents).toBe(1_240_000);
  });

  it('collapses duplicates inside a single file', () => {
    const rows = [row(), row()];
    const res = importPipeline(rows, { mapping, existing: [], now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    expect(res.stats.created).toBe(1);
    expect(res.stats.duplicatesInFile).toBe(1);
  });

  it('decides the arm once and only for newly created dossiers', () => {
    let calls = 0;
    const rows = [row(), row({ 'N° devis': 'D-1002' }), row({ 'N° devis': 'D-1003' })];
    const res = importPipeline(rows, {
      mapping, existing: [], now: NOW, holdoutRate: 0.2,
      assignArm: () => { calls += 1; return 'treatment'; },
    });
    expect(calls).toBe(3);
    expect(res.arms.size).toBe(3);
  });

  it('CRITICAL: the holdout share lands within 1.5 points over 10 000 rows', () => {
    // Seeded, deterministic "random" arm assignment standing in for crypto.randomInt.
    let seed = 42;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const rows = Array.from({ length: 10_000 }, (_, i) =>
      row({ 'N° devis': `D-${i}`, Client: `Client ${i}` }),
    );
    const res = importPipeline(rows, {
      mapping, existing: [], now: NOW, holdoutRate: 0.2,
      assignArm: () => (rnd() < 0.2 ? 'holdout' : 'treatment'),
    });
    const holdout = [...res.arms.values()].filter((a) => a === 'holdout').length;
    const share = (holdout / res.arms.size) * 100;
    expect(share).toBeGreaterThan(18.5);
    expect(share).toBeLessThan(21.5);
  });

  it('keeps the file date convention when it is month-first', () => {
    const rows = [row({ 'Date envoi': '12/25/2025' }), row({ 'N° devis': 'D-2', 'Date envoi': '03/04/2026' })];
    const res = importPipeline(rows, { mapping, existing: [], now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    expect(res.dateConvention).toBe('MDY');
    expect(res.toCreate.find((o) => o.externalRef === 'D-2')!.sentAt.slice(0, 10)).toBe('2026-03-04');
  });

  it('handles 10 000 rows without throwing', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => row({ 'N° devis': `D-${i}`, Client: `C${i}` }));
    const t0 = Date.now();
    const res = importPipeline(rows, { mapping, existing: [], now: NOW, holdoutRate: 0.2, assignArm: alwaysTreatment });
    expect(res.stats.created).toBe(10_000);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
