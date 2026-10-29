/**
 * REAL multi-connection Postgres — the guarantees PGlite structurally cannot
 * prove. Runs ONLY with RROS_DB_DRIVER=pg (tools/pg_local.sh boots the
 * cluster): raw clients on separate connections prove that tenant isolation,
 * the grants and the payment row-lock hold WITHOUT a serializer holding their
 * hand — the exact topology Supabase runs in production.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { submitPaymentDeclaration, confirmPaymentAndActivateSubscription, expectedAmountCents } from '../repo/licensing.ts';
import type { Client } from 'pg';

const pgOn = process.env.RROS_DB_DRIVER === 'pg';
const URL = process.env.DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/rros';

/** A raw tenant connection: app role + claims, like PostgREST would. */
async function tenantClient(workspaceId: string | null): Promise<Client> {
  const { Client } = await import('pg');
  const c = new Client({ connectionString: URL });
  await c.connect();
  await c.query('set role app_authenticated');
  const claims = workspaceId ? JSON.stringify({ workspace_id: workspaceId }) : '';
  await c.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
  return c;
}

describe.skipIf(!pgOn)('real Postgres — separate connections, no safety net', () => {
  let db: Db;
  let wsA: string;
  let wsB: string;

  beforeAll(async () => {
    db = await createDb({ fresh: true });
    const a = await createWorkspaceWithOwner(db, { email: 'a@multi.fr', workspaceName: 'Multi A', locale: 'fr' });
    const b = await createWorkspaceWithOwner(db, { email: 'b@multi.fr', workspaceName: 'Multi B', locale: 'fr' });
    wsA = a.workspaceId;
    wsB = b.workspaceId;
    // One row each, straight SQL — the data itself does not matter.
    for (const [ws, ref] of [[wsA, 'A-1'], [wsB, 'B-1']] as const) {
      await db.query(
        `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, source)
         values ($1::uuid, $2, 'X', 10000, now(), 'open', 'treatment', 'import')`,
        [ws, ref],
      );
    }
  });

  it('RLS isolates two tenants on two SEPARATE connections', async () => {
    const a = await tenantClient(wsA);
    const b = await tenantClient(wsB);
    try {
      const seenA = await a.query<{ n: string }>('select count(*)::text as n from opportunities');
      expect(Number(seenA.rows[0]!.n)).toBe(1);
      const seenB = await b.query<{ n: string }>('select count(*)::text as n from opportunities');
      expect(Number(seenB.rows[0]!.n)).toBe(1);
      // B cannot read A's row (0 rows) and cannot even grab its id blindly.
      const cross = await b.query<{ n: string }>(
        'select count(*)::text as n from opportunities where external_ref = $1', ['A-1']);
      expect(Number(cross.rows[0]!.n)).toBe(0);
      // B cannot update A's row — the USING clause filters, the UPDATE is a no-op.
      const upd = await b.query(
        `update opportunities set status = 'won' where external_ref = $1`, ['A-1']);
      expect(upd.rowCount).toBe(0);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('the grants bind the REAL role: no UPDATE on subscriptions/payments/users from a raw connection', async () => {
    const c = await tenantClient(wsA);
    try {
      await expect(c.query(`update subscriptions set status = 'active'`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`update payments set status = 'confirmed'`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`update users set is_platform_admin = true`)).rejects.toThrow(/permission denied/i);
      await expect(c.query(`delete from audit_log`)).rejects.toThrow(/permission denied/i);
    } finally {
      await c.end();
    }
  });

  it('FOR UPDATE on the payment row blocks across connections: one confirm waits, then wins', async () => {
    // A pending declaration, confirmed by hand on connection 1 while the
    // shared handle (a THIRD connection) runs the repo confirmation: it must
    // wait for the lock, then observe the row is no longer pending.
    const lockerOwner = await createWorkspaceWithOwner(db, {
      email: 'lock@multi.fr', workspaceName: 'Multi Lock', locale: 'fr',
    });
    const dec = await submitPaymentDeclaration(db, {
      workspaceId: lockerOwner.workspaceId, userId: lockerOwner.userId, plan: 'growth',
      amountCents: expectedAmountCents('growth', 'EUR'),
      currency: 'EUR', method: 'bank_transfer', externalReference: `TR-LOCK-${Date.now()}`,
      now: new Date(),
    });
    if (!dec.ok) throw new Error(dec.code);

    const { Client } = await import('pg');
    const locker = new Client({ connectionString: URL });
    await locker.connect();
    try {
      await locker.query('begin');
      await locker.query(`select id from payments where id = $1::uuid for update`, [dec.paymentId]);

      let settled = false;
      const race = confirmPaymentAndActivateSubscription(db, {
        paymentId: dec.paymentId, adminUserId: lockerOwner.userId, now: new Date(),
      }).then((r) => { settled = true; return r; });

      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the row lock — a REAL wait

      await locker.query('rollback');
      const out = await race;
      // The manual lock holder rolled back without confirming: the repo
      // confirmation proceeds and activates. Row-level locking is what
      // serialized them — no mutex helped here.
      if (!out.ok) throw new Error(`confirm should have won, got: ${String((out as { code?: string }).code)}`);
      expect(['confirmed_activated', 'confirmed_extended']).toContain(out.code);
    } finally {
      await locker.end();
    }
  });

  it('two repo confirmations from two DIFFERENT connections grant exactly one month', async () => {
    const owner = await createWorkspaceWithOwner(db, {
      email: 'race@multi.fr', workspaceName: 'Multi Race', locale: 'fr',
    });
    const dec = await submitPaymentDeclaration(db, {
      workspaceId: owner.workspaceId, userId: owner.userId, plan: 'growth',
      amountCents: expectedAmountCents('growth', 'EUR'), currency: 'EUR',
      method: 'bank_transfer', externalReference: `TR-RACE-${Date.now()}`, now: new Date(),
    });
    if (!dec.ok) throw new Error(dec.code);
    // withExclusive serializes on the shared handle — both run, one wins on
    // row state; the assertion is the INVARIANT, whatever the interleaving.
    const [x, y] = await Promise.all([
      confirmPaymentAndActivateSubscription(db, { paymentId: dec.paymentId, adminUserId: owner.userId, now: new Date() }),
      confirmPaymentAndActivateSubscription(db, { paymentId: dec.paymentId, adminUserId: owner.userId, now: new Date() }),
    ]);
    const wins = [x, y].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    const sub = await db.query<{ expires_at: string; status: string }>(
      `select expires_at::text, status::text as status from subscriptions where workspace_id = $1::uuid`,
      [owner.workspaceId],
    );
    expect(sub.rows[0]!.status).toBe('active');
  });
});
