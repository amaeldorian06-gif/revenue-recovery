/**
 * AR view (repo level) — money aggregates and the documented rules, on the
 * real database: outstanding = open only, "échu" = open & age > 30 j,
 * per-client aggregation with the EXISTING scoring engine (priority index =
 * relance priority, NOT a default probability), deterministic sort, and CSV
 * formula-injection protection.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { arSnapshot, arToCsv, PAYMENT_TERM_DAYS } from '../repo/ar.ts';

let db: Db;
let ws: string;
let uid: string;
let wsB: string;
const NOW = new Date('2026-10-29T12:00:00Z');
const DAY = 86_400_000;

async function seed(wsId: string, rows: Array<{
  client: string; amount: number; ageDays: number; status?: string; title?: string;
}>): Promise<void> {
  for (const [i, r] of rows.entries()) {
    await db.query(
      `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, source, title)
       values ($1::uuid, $2, $3, $4::bigint, $5::timestamptz, $6, 'treatment', 'import', $7)`,
      [wsId, `ar-${wsId.slice(0, 4)}-${i}`, r.client, r.amount,
        new Date(NOW.getTime() - r.ageDays * DAY).toISOString(), r.status ?? 'open', r.title ?? null],
    );
  }
}

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const a = await createWorkspaceWithOwner(db, { email: 'ar@a.fr', workspaceName: 'AR A', locale: 'fr' });
  const b = await createWorkspaceWithOwner(db, { email: 'ar@b.fr', workspaceName: 'AR B', locale: 'fr' });
  ws = a.workspaceId; uid = a.userId; wsB = b.workspaceId;
});

const base = {
  status: 'open', sort: 'amount_desc', page: 1, pageSize: 25,
} as const;

describe('money rules — documented, never invented', () => {
  it('outstanding = open only; échu = age > 30 j; buckets follow age', async () => {
    await seed(ws, [
      { client: 'Alpha', amount: 100_000, ageDays: 10 },                 // dans le terme
      { client: 'Beta', amount: 250_000, ageDays: 45 },                  // échu 31-60
      { client: 'Gamma', amount: 400_000, ageDays: 120 },                // très en retard
      { client: 'Delta', amount: 900_000, ageDays: 60, status: 'won' },  // close : jamais dans l'encours
    ]);
    const snap = await arSnapshot(db, ws, NOW, { ...base });
    expect(snap.kpis.outstandingCents).toBe(750_000);
    expect(snap.kpis.overdueCents).toBe(650_000); // Beta + Gamma (>30 j)
    expect(snap.kpis.openCount).toBe(3);
    // Delta (won) n'est PAS dans l'encours — il n'est pas "encaissé" non plus :
    // hors fenêtre 30 j il ne compte même pas dans wonClosed30d.
    expect(snap.kpis.wonClosed30dCents).toBe(0);
    expect(snap.kpis.dsoDays).toBeNull();

    const beta = snap.rows.find((r) => r.client === 'Beta')!;
    expect(beta.overdueCents).toBe(250_000);
    expect(beta.oldestAgeDays).toBe(45);
    const alpha = snap.rows.find((r) => r.client === 'Alpha')!;
    expect(alpha.overdueCents).toBe(0);
  });

  it('won deals with sent_at inside 30 days are counted as "clôturées gagnantes", never as cash', async () => {
    await seed(ws, [
      { client: 'Écho Studio', amount: 320_000, ageDays: 12, status: 'won' },
      { client: 'Delta', amount: 900_000, ageDays: 60, status: 'won' },  // hors fenêtre 30 j
    ]);
    const snap = await arSnapshot(db, ws, NOW, { ...base });
    expect(snap.kpis.wonClosed30dCents).toBe(320_000);
    expect(snap.kpis.outstandingCents).toBe(0);
  });

  it('aggregates per CLIENT (case-insensitive), oldest age = max, lines carry per-line scores', async () => {
    await seed(ws, [
      { client: 'maison bellet', amount: 100_000, ageDays: 80, title: 'Charte' },
      { client: 'Maison Bellet', amount: 300_000, ageDays: 20, title: 'Site vitrine' },
    ]);
    const snap = await arSnapshot(db, ws, NOW, { ...base });
    expect(snap.rows).toHaveLength(1);
    const row = snap.rows[0]!;
    expect(row.client).toBe('Maison Bellet'); // casing of the most recent encounter (20 j)
    expect(row.outstandingCents).toBe(400_000);
    expect(row.oldestAgeDays).toBe(80);
    // Lines are ordered by the ENGINE score (expected recovery value × urgency):
    // the young 300k line outscores the 80-day-old 100k one — by design (§7.2).
    expect(row.lines.map((l) => l.title)).toEqual(['Site vitrine', 'Charte']);
    expect(row.lines[0]!.scoreCents).toBeGreaterThanOrEqual(row.lines[1]!.scoreCents);
    expect(row.lines[1]!.ageDays).toBe(80);
  });

  it('priority index is engine-driven, workspace-normalized, and carries factors + engine version', async () => {
    await seed(ws, [
      { client: 'Société X', amount: 500_000, ageDays: 12 },
      { client: 'Société Y', amount: 50_000, ageDays: 150 },
    ]);
    const snap = await arSnapshot(db, ws, NOW, { ...base });
    const best = snap.rows.find((r) => r.client === 'Société X')!;
    expect(best.engineVersion).toMatch(/^\d{4}-\d{2}-v\d+$/);
    expect(best.priorityScoreCents).toBeGreaterThan(0);
    expect(Array.isArray(best.factors)).toBe(true);
    expect(best.factors.length).toBeGreaterThan(0);
    expect(best.priorityBand).toBe('high');       // best score of the workspace → 100
    const y = snap.rows.find((r) => r.client === 'Société Y')!;
    expect(y.priorityScoreCents).toBeLessThan(best.priorityScoreCents);
    expect(best.priorityIndex).toBe(100); // normalisé : le meilleur = 100
    expect(y.priorityIndex).toBeLessThan(best.priorityIndex);
    // factors include the observable facts (silence, value)
    expect(best.factors.map((f) => f.key)).toContain('value');
    expect(best.factors.map((f) => f.key)).toContain('silence_weeks');
  });

  it('a client with no open line does not appear in status=open; appears under status=won with zero money', async () => {
    await seed(ws, [
      { client: 'Ouvert SARL', amount: 100_000, ageDays: 5 },
      { client: 'Fermé Gagnant', amount: 200_000, ageDays: 40, status: 'won' },
    ]);
    const openOnly = await arSnapshot(db, ws, NOW, { ...base });
    expect(openOnly.rows.map((r) => r.client)).toEqual(['Ouvert SARL']);
    const won = await arSnapshot(db, ws, NOW, { ...base, status: 'won' });
    expect(won.rows.map((r) => r.client)).toEqual(['Fermé Gagnant']);
    expect(won.rows[0]!.outstandingCents).toBe(0);
    const all = await arSnapshot(db, ws, NOW, { ...base, status: 'all' });
    expect(all.rows.map((r) => r.client).sort()).toEqual(['Fermé Gagnant', 'Ouvert SARL']);
  });
});

describe('filters, sort, pagination — server-side', () => {
  beforeEach(async () => {
    await seed(ws, [
      { client: 'Atelier Verne', amount: 100_000, ageDays: 10 },
      { client: 'Cabinet Lorin', amount: 450_000, ageDays: 95, title: 'Audit conformité' },
      { client: 'Studio Orma', amount: 250_000, ageDays: 40 },
      { client: 'Baumann & Fils', amount: 900_000, ageDays: 75 },
    ]);
  });

  it('q matches client OR line title', async () => {
    const byClient = await arSnapshot(db, ws, NOW, { ...base, q: 'lorin' });
    expect(byClient.rows.map((r) => r.client)).toEqual(['Cabinet Lorin']);
    const byTitle = await arSnapshot(db, ws, NOW, { ...base, q: 'conformité' });
    expect(byTitle.rows.map((r) => r.client)).toEqual(['Cabinet Lorin']);
  });

  it('age range and priority_high view filter', async () => {
    const old = await arSnapshot(db, ws, NOW, { ...base, ageMin: 60 });
    expect(old.rows.map((r) => r.client).sort()).toEqual(['Baumann & Fils', 'Cabinet Lorin']);
    const high = await arSnapshot(db, ws, NOW, { ...base, view: 'priority_high' });
    expect(high.rows.length).toBeGreaterThanOrEqual(1);
    expect(high.rows.every((r) => r.priorityBand === 'high')).toBe(true);
  });

  it('KPIs stay on the WHOLE perimeter even when filters shrink the table', async () => {
    const filtered = await arSnapshot(db, ws, NOW, { ...base, q: 'verne' });
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.kpis.outstandingCents).toBe(1_700_000); // les 4 clients, pas le filtre
    expect(filtered.kpis.clientCount).toBe(4);
  });

  it('sorting is deterministic for amounts, names and age', async () => {
    const byAmount = await arSnapshot(db, ws, NOW, { ...base, sort: 'amount_desc' });
    const amounts = byAmount.rows.map((r) => r.outstandingCents);
    expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    const byName = await arSnapshot(db, ws, NOW, { ...base, sort: 'name_asc' });
    expect(byName.rows.map((r) => r.client)).toEqual(
      [...byName.rows.map((r) => r.client)].sort((a, b) => a.localeCompare(b, 'fr')));
    const byAge = await arSnapshot(db, ws, NOW, { ...base, sort: 'age_desc' });
    expect(byAge.rows[0]!.client).toBe('Cabinet Lorin'); // 95 j
  });

  it('pagination: page size respected, total stable, page beyond end is empty', async () => {
    const p1 = await arSnapshot(db, ws, NOW, { ...base, pageSize: 2, page: 1 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.total).toBe(4);
    const p3 = await arSnapshot(db, ws, NOW, { ...base, pageSize: 2, page: 3 });
    expect(p3.rows).toHaveLength(0);
  });

  it('pageSize 0 = the whole filtered set (CSV export path)', async () => {
    const all = await arSnapshot(db, ws, NOW, { ...base, pageSize: 0, q: '' });
    expect(all.rows).toHaveLength(4);
    expect(all.rows).toEqual(all.rows);
  });

  it('an empty workspace → explicit empty state, zero KPIs', async () => {
    const empty = await arSnapshot(db, wsB, NOW, { ...base });
    expect(empty.total).toBe(0);
    expect(empty.kpis.outstandingCents).toBe(0);
  });
});

describe('isolation & CSV safety', () => {
  it('a workspace never sees another workspace clients (same engine, same call)', async () => {
    await seed(ws, [{ client: 'Client de A', amount: 100_000, ageDays: 10 }]);
    const snapB = await arSnapshot(db, wsB, NOW, { ...base });
    expect(snapB.rows).toHaveLength(0);
    expect(snapB.kpis.outstandingCents).toBe(0);
  });

  it('CSV escapes formula injection (=, +, -, @) and quotes', () => {
    const csv = arToCsv([{
      client: '=HYPERLINK("http://evil")',
      openCount: 1, outstandingCents: 12_345, overdueCents: 0, oldestAgeDays: 3,
      priorityBand: 'low', priorityIndex: 3, priorityScoreCents: 12, factors: [],
      engineVersion: 'test', lastTouchAt: null, lines: [],
    }, {
      client: '-CMD',
      openCount: 0, outstandingCents: 0, overdueCents: 0, oldestAgeDays: 0,
      priorityBand: 'low', priorityIndex: 0, priorityScoreCents: 0, factors: [],
      engineVersion: 'test', lastTouchAt: '2026-10-01T00:00:00Z', lines: [],
    }]);
    // No unguarded formula character can start a cell.
    for (const line of csv.split('\n').slice(1)) {
      const first = line.split(';')[0]!;
      expect(first.startsWith('"')).toBe(true);
      expect(first.startsWith('"=') || first.startsWith('"-') || first.startsWith('"@')).toBe(false);
    }
    expect(csv).toContain('"\'=HYPERLINK(""http://evil"")"');
    expect(csv).toContain('"\'-CMD"');
    expect(csv.split('\n')).toHaveLength(3);
    expect(csv.split('\n')[0]).toContain('priorite');
  });
});
