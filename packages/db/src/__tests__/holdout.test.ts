/**
 * Launch gate I2 — the holdout is frozen AT THE DATABASE, not by the absence
 * of a button. With the application's own tenant role (the most privileged
 * thing a request can carry), a direct SQL UPDATE of the arm must be refused
 * by the trigger. Inserting a row WITH an arm stays legal: that is the import.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, asWorkspace, asSuperuser, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';

let db: Db;
let ws: string;
let oppId: string;

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const a = await createWorkspaceWithOwner(db, {
    email: 'i2@agence.fr', workspaceName: 'Gate I2', locale: 'fr',
  });
  ws = a.workspaceId;
  const opp = await db.query<{ id: string }>(
    `insert into opportunities (workspace_id, external_ref, client_name, amount_cents,
                                sent_at, status, arm, stage)
     values ($1::uuid, 'gate-i2', 'Client Témoin', 500000, now() - interval '30 days', 'open', 'holdout', 'proposal_sent')
     returning id`,
    [ws],
  );
  oppId = opp.rows[0]!.id;
});

describe('I2 — direct SQL with the app role cannot move an arm', () => {
  it('the tenant role cannot move a dossier out of the holdout', async () => {
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update opportunities set arm = 'treatment' where id = $1::uuid`, [oppId]);
    })).rejects.toThrow(/arm is immutable/);
  });

  it('the tenant role cannot move a dossier INTO the holdout either', async () => {
    // A treatment row exists (a real customer dossier): pulling it into the
    // control group would be the tempting fraud — it must refuse too.
    const t = await db.query<{ id: string }>(
      `insert into opportunities (workspace_id, external_ref, client_name, amount_cents,
                                  sent_at, status, arm, stage)
       values ($1::uuid, 'gate-i2-treat', 'Client Traité', 100000, now() - interval '10 days', 'open', 'treatment', 'proposal_sent')
       returning id`,
      [ws],
    );
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update opportunities set arm = 'holdout' where id = $1::uuid`, [t.rows[0]!.id]);
    })).rejects.toThrow(/arm is immutable/);
  });

  it('even arm_assigned_at is frozen', async () => {
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update opportunities set arm_assigned_at = now() where id = $1::uuid`, [oppId]);
    })).rejects.toThrow(/arm_assigned_at is immutable/);
  });

  it('inserting WITH an arm stays legal — that is what the import does', async () => {
    await asWorkspace(db, ws, async () => {
      const r = await db.query<{ arm: string }>(
        `insert into opportunities (workspace_id, external_ref, client_name, amount_cents,
                                    sent_at, status, arm, stage)
         values ($1::uuid, 'gate-i2-new', 'Autre Client', 100000, now() - interval '10 days', 'open', 'treatment', 'proposal_sent')
         returning arm`,
        [ws],
      );
      expect(r.rows[0]!.arm).toBe('treatment');
    });
  });

  it('the holdout row itself never moved: measured means untouched', async () => {
    const check = await asSuperuser(db, async () =>
      db.query<{ arm: string }>('select arm from opportunities where id = $1::uuid', [oppId]),
    );
    expect(check.rows[0]!.arm).toBe('holdout');
  });
});
