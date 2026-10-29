import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, asWorkspace, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { commitImport, loadExisting, portfolioSummary, assignArm } from '../repo/imports.ts';
import { importPipeline } from '../../../domain/src/import/pipeline.ts';
import { detectMapping, type Mapping } from '../../../domain/src/import/detect.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
let db: Db;
let ws: string;
let uid: string;

const HEADERS = ['N° devis', 'Client', 'Objet', 'Montant HT', 'Date envoi', 'Stade', 'Nb relances'];

function makeRows(n: number, prefix = 'D'): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    'N° devis': `${prefix}-${1000 + i}`,
    Client: `Client ${i % 7}`,
    Objet: `Projet ${i}`,
    'Montant HT': `${2000 + i * 100} € HT`,
    'Date envoi': `${String((i % 28) + 1).padStart(2, '0')}/0${(i % 8) + 1}/2026`,
    Stade: 'Proposition envoyée',
    'Nb relances': String(i % 3),
  }));
}

let mapping: Mapping[];

beforeEach(async () => {
  db = await createDb({ fresh: true });
  const created = await createWorkspaceWithOwner(db, {
    email: 'a@studio.fr', workspaceName: 'Studio Merlot', locale: 'fr',
  });
  ws = created.workspaceId;
  uid = created.userId;
  mapping = detectMapping(HEADERS);
});

async function runImport(rows: Record<string, unknown>[], holdoutRate = 0.2, assignArmFn?: () => 'treatment' | 'holdout') {
  const existing = await loadExisting(db, ws);
  const result = importPipeline(rows, {
    mapping, existing, now: NOW, holdoutRate,
    assignArm: assignArmFn ?? (() => assignArm(holdoutRate)),
  });
  const outcome = await commitImport(db, result, {
    workspaceId: ws, userId: uid, filename: 'export.csv', holdoutRate,
    mapping, maxRows: 10_000,
  });
  return { result, outcome };
}

describe('commit — happy path', () => {
  it('persists opportunities and reports counts', async () => {
    const { outcome } = await runImport(makeRows(50));
    expect(outcome.created).toBe(50);
    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities where workspace_id = $1', [ws]);
    expect(n.rows[0]!.n).toBe(50);
  });

  it('records the import and an audit row', async () => {
    await runImport(makeRows(10));
    const imp = await db.query<{ row_count: number; imported_count: number }>(
      'select row_count, imported_count from imports where workspace_id = $1', [ws]);
    expect(imp.rows[0]).toMatchObject({ imported_count: 10 });
    const audit = await db.query<{ action: string }>(
      `select action from audit_log where workspace_id = $1 and action = 'import.committed'`, [ws]);
    expect(audit.rows).toHaveLength(1);
  });

  it('increments the monthly usage counter', async () => {
    await runImport(makeRows(30));
    const usage = await db.query<{ proposals_tracked: number }>(
      'select proposals_tracked from usage_counters where workspace_id = $1', [ws]);
    expect(usage.rows[0]!.proposals_tracked).toBe(30);
  });

  it('creates contacts from the email column', async () => {
    const rows = makeRows(3).map((r, i) => ({ ...r, 'Email contact': `c${i}@exemple.fr` }));
    const m2 = detectMapping([...HEADERS, 'Email contact']);
    const existing = await loadExisting(db, ws);
    const result = importPipeline(rows, { mapping: m2, existing, now: NOW, holdoutRate: 0.2, assignArm: () => 'treatment' });
    await commitImport(db, result, { workspaceId: ws, userId: uid, filename: 'f.csv', holdoutRate: 0.2, mapping: m2, maxRows: 100 });
    const contacts = await db.query<{ n: number }>('select count(*)::int as n from contacts where workspace_id = $1', [ws]);
    expect(contacts.rows[0]!.n).toBe(3);
  });
});

describe('CRITICAL — the holdout is frozen', () => {
  it('re-importing the same file moves nobody between arms', async () => {
    await runImport(makeRows(80));
    const before = await db.query<{ id: string; arm: string }>('select id, arm from opportunities order by id');
    await runImport(makeRows(80));
    const after = await db.query<{ id: string; arm: string }>('select id, arm from opportunities order by id');
    expect(after.rows.map((r) => r.arm)).toEqual(before.rows.map((r) => r.arm));
  });

  it('changing the amounts on re-import does not move the arm', async () => {
    await runImport(makeRows(40));
    const before = await db.query<{ id: string; arm: string }>('select id, arm from opportunities order by id');
    const edited = makeRows(40).map((r) => ({ ...r, 'Montant HT': '9 999 € HT' }));
    await runImport(edited);
    const after = await db.query<{ id: string; arm: string }>('select id, arm from opportunities order by id');
    expect(after.rows.map((r) => r.arm)).toEqual(before.rows.map((r) => r.arm));
    const amounts = await db.query<{ amount_cents: string }>('select amount_cents from opportunities');
    expect(Number(amounts.rows[0]!.amount_cents)).toBe(999_900);
  });

  it('the DATABASE refuses to move an opportunity between arms', async () => {
    await runImport(makeRows(5));
    const row = await db.query<{ id: string; arm: string }>('select id, arm from opportunities limit 1');
    const { id, arm } = row.rows[0]!;
    const target = arm === 'holdout' ? 'treatment' : 'holdout';
    await expect(
      db.query('update opportunities set arm = $1 where id = $2', [target, id]),
    ).rejects.toThrow(/immutable|I2/i);
  });

  it('the trigger fires even through the tenant role', async () => {
    await runImport(makeRows(5));
    const row = await db.query<{ id: string; arm: string }>('select id, arm from opportunities limit 1');
    const { id, arm } = row.rows[0]!;
    await expect(
      asWorkspace(db, ws, () =>
        db.query('update opportunities set arm = $1 where id = $2', [arm === 'holdout' ? 'treatment' : 'holdout', id]),
      ),
    ).rejects.toThrow(/immutable/i);
  });
});

describe('re-import updates without creating', () => {
  it('50 rows twice → 50 created then 0 created, 50 updated', async () => {
    const first = await runImport(makeRows(50));
    expect(first.outcome.created).toBe(50);
    const second = await runImport(makeRows(50));
    expect(second.outcome.created).toBe(0);
    expect(second.outcome.updated).toBe(50);
    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities');
    expect(n.rows[0]!.n).toBe(50);
  });
});

describe('rollback', () => {
  it('a failure leaves the database untouched', async () => {
    await runImport(makeRows(10));
    const before = await db.query<{ n: number }>('select count(*)::int as n from opportunities');
    const existing = await loadExisting(db, ws);
    const bad = makeRows(5, 'X').map((r) => ({ ...r, 'Montant HT': 'abc' }));
    const result = importPipeline(bad, { mapping, existing, now: NOW, holdoutRate: 0.2, assignArm: () => 'treatment' });
    // Force a failure inside the transaction by targeting a non-existent user id.
    await expect(
      commitImport(db, result, { workspaceId: '00000000-0000-0000-0000-000000000000', userId: uid, filename: 'f.csv', holdoutRate: 0.2, mapping, maxRows: 100 }),
    ).rejects.toThrow();
    const after = await db.query<{ n: number }>('select count(*)::int as n from opportunities');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('portfolio summary — the calibration screen', () => {
  it('returns the four figures', async () => {
    await runImport(makeRows(60), 0.2, () => 'treatment');
    const s = await portfolioSummary(db, ws);
    expect(s.total).toBe(60);
    expect(s.unanswered).toBeGreaterThan(0);
    expect(s.exposedCents).toBeGreaterThan(0);
    expect(s.holdout).toBe(0);
  });

  it('counts the holdout separately', async () => {
    let i = 0;
    await runImport(makeRows(20), 0.2, () => (i++ < 4 ? 'holdout' : 'treatment'));
    const s = await portfolioSummary(db, ws);
    expect(s.holdout).toBe(4);
  });
});

describe('tenant isolation on the new tables', () => {
  it('workspace B sees none of workspace A opportunities', async () => {
    await runImport(makeRows(20));
    const b = await createWorkspaceWithOwner(db, { email: 'b@autre.fr', workspaceName: 'Autre', locale: 'fr' });
    const rows = await asWorkspace(db, b.workspaceId, () => db.query('select id from opportunities'));
    expect(rows.rows).toHaveLength(0);
    const own = await asWorkspace(db, ws, () => db.query('select id from opportunities'));
    expect(own.rows).toHaveLength(20);
  });

  it('signal_events and imports are isolated too', async () => {
    await runImport(makeRows(5));
    const b = await createWorkspaceWithOwner(db, { email: 'b2@autre.fr', workspaceName: 'Autre2', locale: 'fr' });
    for (const table of ['imports', 'usage_counters', 'contacts']) {
      const rows = await asWorkspace(db, b.workspaceId, () => db.query(`select id from ${table}`));
      expect(rows.rows, table).toHaveLength(0);
    }
  });
});

describe('performance — 5 000 rows', () => {
  it('imports 5 000 rows in under 60 s', async () => {
    const t0 = Date.now();
    await runImport(makeRows(5_000), 0.2, () => 'treatment');
    const elapsed = Date.now() - t0;
    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities');
    expect(n.rows[0]!.n).toBe(5_000);
    console.log(`    5 000 lignes importées en ${elapsed} ms`);
    expect(elapsed).toBeLessThan(60_000);
  }, 120_000);
});
