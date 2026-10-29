/**
 * Migration 0010 — revocable sessions. The JWT alone no longer decides: the
 * `sessions` row is the source of truth, revocation is a server-side UPDATE,
 * and the table is tenant-scoped by RLS like everything else. These tests
 * attack the exact predicate getSession() runs and the grants that bind the
 * application role.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, asWorkspace, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';

let db: Db;
let ws: string;
let userId: string;
const OWNER = '00000000-0000-4000-8000-00000000aaaa';

async function insertSession(id: string, opts: { revoked?: boolean; expired?: boolean } = {}): Promise<void> {
  await db.query(
    `insert into sessions (id, user_id, workspace_id, role, email, locale, expires_at, revoked_at)
     values ($1::uuid, $2::uuid, $3::uuid, 'owner', 's@x.fr', 'fr',
             $4::timestamptz, $5::timestamptz)`,
    [
      id, userId, ws,
      new Date(Date.now() + (opts.expired ? -1 : 7) * 86_400_000).toISOString(),
      opts.revoked ? new Date().toISOString() : null,
    ],
  );
}

/** The exact liveness predicate getSession() runs. */
async function alive(sid: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(
    `select not exists (
       select 1 from sessions s
        where s.id = $1::uuid and s.revoked_at is null and s.expires_at > now()
     ) as ok`,
    [sid],
  );
  return !r.rows[0]!.ok;
}

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const a = await createWorkspaceWithOwner(db, {
    email: 'sess@agence.fr', workspaceName: 'Agence Sessions', locale: 'fr',
  });
  ws = a.workspaceId;
  userId = a.userId;
});

describe('session liveness (the predicate getSession runs)', () => {
  it('valid row → alive; revoked → dead; expired → dead', async () => {
    const ok = crypto.randomUUID();
    await insertSession(ok);
    const dead1 = crypto.randomUUID();
    await insertSession(dead1, { revoked: true });
    const dead2 = crypto.randomUUID();
    await insertSession(dead2, { expired: true });

    expect(await alive(ok)).toBe(true);
    expect(await alive(dead1)).toBe(false);
    expect(await alive(dead2)).toBe(false);
  });

  it('revocation is a one-way UPDATE: idempotent, keeps the original reason', async () => {
    const sid = crypto.randomUUID();
    await insertSession(sid);
    for (const reason of ['signout', 'admin_suspend', 'logout_everywhere']) {
      await db.query(
        `update sessions set revoked_at = now(), revoked_reason = $2::text
          where id = $1::uuid and revoked_at is null`,
        [sid, reason],
      );
    }
    const row = await db.query<{ revoked_reason: string; revoked_at: string }>(
      `select revoked_reason, revoked_at::text from sessions where id = $1::uuid`, [sid],
    );
    expect(row.rows[0]!.revoked_reason).toBe('signout'); // first revocation wins
    expect(await alive(sid)).toBe(false);
  });

  it('a session without a row (pre-0010 cookie, forgery) is dead by construction', async () => {
    expect(await alive(crypto.randomUUID())).toBe(false);
  });
});

describe('RLS & grants on sessions', () => {
  it('the tenant reads its workspace sessions only, and can NEVER write them', async () => {
    const other = await createWorkspaceWithOwner(db, {
      email: 'other@agence.fr', workspaceName: 'Agence Other', locale: 'fr',
    });
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    await insertSession(mine);
    await db.query(
      `insert into sessions (id, user_id, workspace_id, role, email, locale, expires_at)
       values ($1::uuid, $2::uuid, $3::uuid, 'owner', 'o@x.fr', 'fr', now() + interval '7 days')`,
      [theirs, other.userId, other.workspaceId],
    );

    await asWorkspace(db, ws, async () => {
      const seen = await db.query<{ n: string }>(`select count(*)::text as n from sessions`);
      expect(Number(seen.rows[0]!.n)).toBe(1); // mine only
      // Write attempts are refused by the GRANTS (no INSERT/UPDATE/DELETE given).
      await expect(db.query(
        `insert into sessions (id, user_id, workspace_id, role, email, locale, expires_at)
         values ($1::uuid, $2::uuid, $3::uuid, 'owner', 'x@x.fr', 'fr', now() + interval '7 days')`,
        [crypto.randomUUID(), userId, ws],
      )).rejects.toThrow(/permission denied/i);
      await expect(db.query(`update sessions set revoked_at = now()`)).rejects.toThrow(/permission denied/i);
      await expect(db.query(`delete from sessions`)).rejects.toThrow(/permission denied/i);
    });
  });
});
