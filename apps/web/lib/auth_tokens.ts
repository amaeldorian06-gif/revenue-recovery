import { createHash } from 'node:crypto';
import type { Db } from '@rros/db';

/**
 * Magic-link token semantics — the security core of passwordless login,
 * injected with the database so they are testable outside a request scope
 * (the route /api/auth/verify calls these; the cookie half of the flow is
 * proven live by tools/session_revocation_check.mjs + tools/magic_link_live.mjs).
 */

/** Atomically consume a valid, unused, unexpired token. Returns its email or null. */
export async function consumeLoginToken(db: Db, token: string): Promise<{ email: string } | null> {
  const rows = await db.query<{ id: string; email: string }>(
    `update login_tokens set used_at = now()
      where token_hash = $1::text and used_at is null and expires_at > now()
      returning id, email`,
    [createHash('sha256').update(token).digest('hex')],
  );
  const row = rows.rows[0];
  return row ? { email: row.email } : null;
}

/** The user a magic link logs in: the OLDEST account for that email (deterministic). */
export async function resolveLoginUser(db: Db, email: string): Promise<{
  id: string; workspace_id: string; role: 'owner' | 'admin' | 'member' | 'viewer';
} | null> {
  const rows = await db.query<{
    id: string; workspace_id: string; role: 'owner' | 'admin' | 'member' | 'viewer';
  }>(
    'select id, workspace_id, role::text as role from users where email = $1::text order by created_at limit 1',
    [email],
  );
  return rows.rows[0] ?? null;
}
