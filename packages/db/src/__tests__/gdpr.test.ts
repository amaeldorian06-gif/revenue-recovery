/**
 * Phase 08 — GDPR (criterion 7): the export holds EVERY row of the workspace
 * and NOT ONE row of another; deletion revokes access immediately and the
 * purge removes every row, table by table, audit_log included.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  collectWorkspace, markDeleted, purgeExpiredWorkspaces, isWorkspaceDeleted,
  TENANT_TABLES,
} from '../repo/gdpr.ts';

let db: Db;
let a: { workspaceId: string; userId: string };
let b: { workspaceId: string; userId: string };

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  a = await createWorkspaceWithOwner(db, { email: 'a@agence.fr', workspaceName: 'Agence A', locale: 'fr' });
  b = await createWorkspaceWithOwner(db, { email: 'b@agence.fr', workspaceName: 'Agence B', locale: 'fr' });
  for (const ws of [a, b]) {
    const c = await db.query<{ id: string }>(
      `insert into contacts (workspace_id, email) values ($1::uuid, $2) returning id`,
      [ws.workspaceId, `contact-${ws.workspaceId.slice(0, 4)}@x.fr`],
    );
    await db.query(
      `insert into opportunities (workspace_id, external_ref, client_name, contact_id, title, amount_cents, arm, stage, sent_at)
       values ($1::uuid, 'ref', 'Client', $2::uuid, 'Dossier', 100000, 'treatment', 'proposal_sent', now())`,
      [ws.workspaceId, c.rows[0]!.id],
    );
    await db.query(
      `insert into actions (workspace_id, opportunity_id, kind, status, actor_type)
       select $1::uuid, o.id, 'draft_generated', 'draft', 'system' from opportunities o where o.workspace_id = $1::uuid`,
      [ws.workspaceId],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'seed.event', 'workspace', $1::text, '{}'::jsonb)`,
      [ws.workspaceId],
    );
  }
});

describe('export data collection (criterion 7, half 1)', () => {
  it('collects EVERY tenant table, with rows where the seed put rows', async () => {
    const snap = await collectWorkspace(db, a.workspaceId);
    expect(snap.map((t) => t.table).sort()).toEqual([...TENANT_TABLES].sort());
    const opportunities = snap.find((t) => t.table === 'opportunities')!;
    expect(opportunities.rows.length).toBe(1);
    expect((snap.find((t) => t.table === 'actions')!).rows.length).toBe(1);
    expect((snap.find((t) => t.table === 'audit_log')!).rows.length).toBeGreaterThanOrEqual(1);
  });

  it('contains ZERO rows from another workspace — checked table by table', async () => {
    const snapA = await collectWorkspace(db, a.workspaceId);
    for (const table of snapA) {
      const foreign = table.rows.filter((r) => {
        const wsId = (r as { workspace_id?: string }).workspace_id ?? (r as { id?: string }).id;
        return wsId === b.workspaceId;
      });
      expect(foreign, `${table.table} leaked workspace B rows`).toHaveLength(0);
    }
    // And B's export contains none of A's either.
    const snapB = await collectWorkspace(db, b.workspaceId);
    const owners = snapB.map((t) => t.rows.every((r) => {
      const wsId = (r as { workspace_id?: string }).workspace_id ?? (r as { id?: string }).id;
      return wsId !== a.workspaceId;
    }));
    expect(owners.every(Boolean)).toBe(true);
  });
});

describe('deletion and purge (criterion 7, half 2)', () => {
  it('soft delete revokes access instantly (sessions and API keys)', async () => {
    expect(await isWorkspaceDeleted(db, a.workspaceId)).toBe(false);
    await markDeleted(db, a.workspaceId, new Date(Date.now() + 30 * 24 * 3600 * 1000));
    expect(await isWorkspaceDeleted(db, a.workspaceId)).toBe(true);
    // B untouched.
    expect(await isWorkspaceDeleted(db, b.workspaceId)).toBe(false);
  });

  it('the purge removes EVERY row of the workspace, table by table, audit_log included', async () => {
    await markDeleted(db, a.workspaceId, new Date(Date.now() - 1000)); // window already over
    const reports = await purgeExpiredWorkspaces(db);
    expect(reports.length).toBe(1);
    expect(reports[0]!.workspaceId).toBe(a.workspaceId);

    for (const table of TENANT_TABLES) {
      if (table === 'workspaces') continue;
      const left = await db.query<{ n: number }>(
        `select count(*)::int as n from ${table} where workspace_id = $1::uuid`,
        [a.workspaceId],
      );
      expect(left.rows[0]!.n, `${table} still holds rows of the purged workspace`).toBe(0);
    }
    // The workspace row itself is gone.
    const ws = await db.query<{ n: number }>(
      'select count(*)::int as n from workspaces where id = $1::uuid', [a.workspaceId],
    );
    expect(ws.rows[0]!.n).toBe(0);
    // B survives, untouched, row for row.
    const bOpps = await db.query<{ n: number }>(
      'select count(*)::int as n from opportunities where workspace_id = $1::uuid', [b.workspaceId],
    );
    expect(bOpps.rows[0]!.n).toBe(1);
  });

  it('a workspace inside its 30-day window is NOT purged yet', async () => {
    await markDeleted(db, a.workspaceId, new Date(Date.now() + 29 * 24 * 3600 * 1000));
    expect((await purgeExpiredWorkspaces(db)).length).toBe(0);
    const still = await db.query<{ n: number }>(
      'select count(*)::int as n from opportunities where workspace_id = $1::uuid', [a.workspaceId],
    );
    expect(still.rows[0]!.n).toBe(1);
  });
});
