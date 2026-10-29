/**
 * Phase 06 — criteria 8 and 9, plus the demo guard.
 *
 * The wizard must never lose progress (server-side state), and the demo
 * portfolio must be exactly what the calibration screen promises: 20 French
 * dossiers, 4 holdout, one verbal agreement, one aged out, realistic amounts.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  demoOpportunities, seedDemo, getOnboardingState, patchOnboardingState,
  createDemoWorkspace, DemoDataConflictError,
} from '../repo/onboarding.ts';

let db: Db;
let workspaceId: string;
const NOW = new Date('2026-10-26T10:00:00Z');

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const created = await createWorkspaceWithOwner(db, {
    email: 'onboarding@verger-loire.fr', workspaceName: 'Verger de Loire', locale: 'fr',
  });
  workspaceId = created.workspaceId;
});

describe('criterion 9 — the demo portfolio is exact', () => {
  it('the pure generator: 20 dossiers, 4 holdout, one verbal, one aged, amounts €2 100–€45 000', () => {
    const rows = demoOpportunities(NOW);
    expect(rows).toHaveLength(20);
    expect(rows.filter((r) => r.arm === 'holdout')).toHaveLength(4);

    const verbal = rows.filter((r) => r.stage === 'verbal_yes');
    expect(verbal).toHaveLength(1);
    expect(verbal[0]!.arm).toBe('treatment'); // the verbal agreement keeps being followed up

    const aged = rows.filter((r) => r.sentDaysAgo > 42);
    expect(aged).toHaveLength(1);
    expect(aged[0]!.touchCount).toBe(3); // out of touches: the window is closed

    for (const r of rows) {
      expect(r.amountCents).toBeGreaterThanOrEqual(2_100 * 100);
      expect(r.amountCents).toBeLessThanOrEqual(45_000 * 100);
      expect(r.clientName.length).toBeGreaterThan(2);
    }
    // Realistic French names, unique external refs.
    expect(new Set(rows.map((r) => r.externalRef)).size).toBe(20);
  });

  it('seeding writes exactly that portfolio and marks the workspace demo_seeded', async () => {
    const out = await seedDemo(db, workspaceId, { now: NOW });
    expect(out.inserted).toBe(20);
    expect(out.holdout).toBe(4);

    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities where workspace_id = $1::uuid', [workspaceId]);
    expect(n.rows[0]!.n).toBe(20);

    const ws = await db.query<{ demo_seeded: boolean }>('select demo_seeded from workspaces where id = $1::uuid', [workspaceId]);
    expect(ws.rows[0]!.demo_seeded).toBe(true);

    // Idempotent: running it again changes nothing (external_ref conflicts do nothing).
    const again = await seedDemo(db, workspaceId, { now: NOW });
    expect(again.inserted).toBe(20);
    const n2 = await db.query<{ n: number }>('select count(*)::int as n from opportunities where workspace_id = $1::uuid', [workspaceId]);
    expect(n2.rows[0]!.n).toBe(20);
  });

  it('the guard: real data blocks the demo, replace swaps only demo rows', async () => {
    await db.query(
      `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, source)
       values ($1::uuid, 'real-1', 'Client Réel', 900000, now() - interval '3 days', 'open', 'treatment', 'import')`,
      [workspaceId],
    );
    await expect(seedDemo(db, workspaceId, { now: NOW })).rejects.toBeInstanceOf(DemoDataConflictError);
    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities where workspace_id = $1::uuid', [workspaceId]);
    expect(n.rows[0]!.n).toBe(1); // nothing mixed in

    await seedDemo(db, workspaceId, { replace: true, now: NOW });
    const after = await db.query<{ src: string; n: number }>(
      `select source as src, count(*)::int as n from opportunities where workspace_id = $1::uuid group by source`,
      [workspaceId],
    );
    // The real dossier survived; the demo rows were swapped in.
    expect(after.rows.find((r) => r.src === 'import')?.n).toBe(1);
    expect(after.rows.find((r) => r.src === 'demo')?.n).toBe(20);
  });
});

describe('criterion 8 — wizard state survives a refresh', () => {
  it('state persists server-side: patch, close, re-read, same step and data', async () => {
    await patchOnboardingState(db, workspaceId, { stepDone: 'account', step: 2, timezone: 'Europe/Zurich' });
    await patchOnboardingState(db, workspaceId, { stepDone: 'mailbox', step: 3, mailboxChoice: 'later' });

    const state = await getOnboardingState(db, workspaceId);
    expect(state.currentStep).toBe(3);
    expect(state.stepsDone).toEqual(expect.arrayContaining(['account', 'mailbox']));
    expect(state.timezone).toBe('Europe/Zurich');
    expect(state.mailboxChoice).toBe('later');

    // Never steps backwards by URL: greatest() wins.
    await patchOnboardingState(db, workspaceId, { step: 1 });
    const after = await getOnboardingState(db, workspaceId);
    expect(after.currentStep).toBe(3);
  });

  it('staged import id survives the wizard round-trip', async () => {
    const importId = crypto.randomUUID();
    await db.query(
      `insert into imports (id, workspace_id, filename, row_count, mapping, status, staged_rows, headers)
       values ($1::uuid, $2::uuid, 'octobre.csv', 2, '{}', 'parsed', '[{"a":1}]'::jsonb, '["a"]'::jsonb)`,
      [importId, workspaceId],
    );
    await patchOnboardingState(db, workspaceId, { stagedImportId: importId, step: 4, stepDone: 'import' });
    const state = await getOnboardingState(db, workspaceId);
    expect(state.stagedImportId).toBe(importId);
    const back = await db.query<{ staged_rows: unknown; mapping: unknown }>(
      'select staged_rows, mapping from imports where id = $1::uuid',
      [importId],
    );
    expect(back.rows[0]!.staged_rows).toEqual([{ a: 1 }]);
  });
});

describe('the login-screen demo workspace', () => {
  it('creates an isolated workspace, seeded, onboarding complete, sandbox trial', async () => {
    const demo = await createDemoWorkspace(db);
    const ws = await db.query<{ name: string; trial_ends_at: Date; demo_seeded: boolean }>(
      'select name, trial_ends_at, demo_seeded from workspaces where id = $1::uuid',
      [demo.workspaceId],
    );
    expect(ws.rows[0]!.demo_seeded).toBe(true);

    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities where workspace_id = $1::uuid', [demo.workspaceId]);
    expect(n.rows[0]!.n).toBe(20);

    const st = await getOnboardingState(db, demo.workspaceId);
    expect(st.currentStep).toBe(5);
    expect(st.stepsDone).toContain('calibration');

    // The demo adds its own workspace — and never touches the beforeEach one.
    const others = await db.query<{ n: number }>('select count(*)::int as n from workspaces');
    expect(others.rows[0]!.n).toBe(2);
  });
});
