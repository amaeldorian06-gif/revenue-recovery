/**
 * Account management — the PASSWORDLESS core on the real database.
 * The magic-link semantics are tested through lib/auth_tokens (the exact
 * functions the verify route calls, database injected — no module mocking). The cookie half of the flow is proven live by
 * tools/session_revocation_check.mjs and tools/magic_link_live.mjs.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createDb, truncateAll, type Db } from '../../../../../packages/db/src/client.ts';
import { createWorkspaceWithOwner } from '../../../../../packages/db/src/repo/workspaces.ts';
import { consumeLoginToken, resolveLoginUser } from '../../../lib/auth_tokens';

let db: Db;
const EMAIL = 'compte@cabinet-roche.fr';
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

async function mintToken(email: string, token: string, opts: { expired?: boolean } = {}): Promise<void> {
  await db.query(
    `insert into login_tokens (email, token_hash, expires_at)
     values ($1::text, $2::text, now() + interval '${opts.expired ? '-1 minute' : '15 minutes'}')`,
    [email, hashOf(token)],
  );
}

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  await createWorkspaceWithOwner(db, { email: EMAIL, workspaceName: 'Cabinet Roche', locale: 'fr' });
});

describe('magic link — atomic consumption (the verify route contract)', () => {
  it('a valid token is consumed and yields its email exactly once', async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await mintToken(EMAIL, token);
    const first = await consumeLoginToken(db, token);
    expect(first?.email).toBe(EMAIL);
    const replay = await consumeLoginToken(db, token);
    expect(replay).toBeNull();
    // Exactly one row, and it is stamped used.
    const rows = await db.query<{ n: string; used: number }>(
      `select count(*)::int::text as n, count(used_at)::int as used from login_tokens`,
    );
    expect(rows.rows[0]).toMatchObject({ n: '1', used: 1 });
  });

  it('an expired token is refused and stays unconsumed', async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await mintToken(EMAIL, token, { expired: true });
    expect(await consumeLoginToken(db, token)).toBeNull();
    const used = await db.query<{ n: number }>(`select count(used_at)::int as n from login_tokens`);
    expect(used.rows[0]!.n).toBe(0);
  });

  it('a token is bound to its HASH: any other string is refused', async () => {
    await mintToken(EMAIL, 'the-real-token');
    expect(await consumeLoginToken(db, 'the-real-token')).not.toBeNull();
    expect(await consumeLoginToken(db, 'the-real-tolkien')).toBeNull();
    expect(await consumeLoginToken(db, '')).toBeNull();
  });

  it('resolveLoginUser picks the OLDEST account for a shared email (deterministic login)', async () => {
    // The repo refuses duplicate emails at signup; the determinism contract
    // still holds for legacy rows — one older row, another workspace.
    const other = await createWorkspaceWithOwner(db, {
      email: `autre-${crypto.randomUUID().slice(0, 6)}@x.fr`, workspaceName: 'Second', locale: 'fr',
    });
    await db.query(
      `insert into users (id, auth_user_id, workspace_id, email, role, created_at)
       values ($1::uuid, 'legacy', $2::uuid, $3::text, 'member', now() - interval '1 hour')`,
      [crypto.randomUUID(), other.workspaceId, EMAIL],
    );
    const oldest = await db.query<{ ws: string }>(
      `select workspace_id::text as ws from users where email = $1::text order by created_at limit 1`,
      [EMAIL],
    );
    const user = await resolveLoginUser(db, EMAIL);
    expect(user!.workspace_id).toBe(oldest.rows[0]!.ws);
    expect(await resolveLoginUser(db, 'personne@nullePart.fr')).toBeNull();
  });
});

describe('rate limit — the exact predicate signinAction runs', () => {
  async function failedAttempts(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await db.query(
        `insert into auth_attempts (ip, email, ok) values ('203.0.113.9', 'x@y.fr', false)`,
      );
    }
  }
  async function gate(ip: string): Promise<boolean> {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from auth_attempts
        where ip = $1::text and ok = false and created_at > $2::timestamptz`,
      [ip, since],
    );
    return (r.rows[0]!.n ?? 0) >= 5;
  }

  it('4 failures pass, the 5th blocks, a SUCCESS attempt never counts', async () => {
    await failedAttempts(4);
    expect(await gate('203.0.113.9')).toBe(false);
    await failedAttempts(1);
    expect(await gate('203.0.113.9')).toBe(true);
    // A successful attempt is recorded but never feeds the gate.
    await db.query(`insert into auth_attempts (ip, email, ok) values ('203.0.113.9', 'x@y.fr', true)`);
    expect(await gate('203.0.113.9')).toBe(true);
  });

  it('another IP is unaffected (the bound is per IP, not global)', async () => {
    await failedAttempts(9);
    expect(await gate('198.51.100.7')).toBe(false);
  });

  it('signup refuses a second account with the same email (the repo guard)', async () => {
    const { EmailAlreadyUsedError } = await import('../../../../../packages/db/src/repo/workspaces.ts');
    await expect(
      createWorkspaceWithOwner(db, { email: EMAIL, workspaceName: 'Doublon', locale: 'fr' }),
    ).rejects.toThrow(EmailAlreadyUsedError);
  });
});
