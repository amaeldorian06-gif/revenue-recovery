import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { createSession } from '../../../../lib/session';
import { consumeLoginToken, resolveLoginUser } from '../../../../lib/auth_tokens';

export const dynamic = 'force-dynamic';

/**
 * Magic-link completion: hashed token, 15-minute expiry, SINGLE use (the
 * token row is consumed in the same statement that reads it — a replayed
 * link finds used_at set and stops). The security semantics live in
 * lib/auth_tokens.ts (database-injected, unit-tested); this handler adds
 * the request-scoped cookie, proven live by the browser walks.
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? '';
  if (!token) return NextResponse.redirect(new URL('/fr/login?error=link_invalid', req.url));
  const row = await asAdmin((db) => consumeLoginToken(db, token));
  if (!row) return NextResponse.redirect(new URL('/fr/login?error=link_invalid', req.url));
  const u = await asAdmin((db) => resolveLoginUser(db, row.email));
  if (!u) return NextResponse.redirect(new URL('/fr/login?error=link_invalid', req.url));
  await createSession({
    userId: u.id, workspaceId: u.workspace_id, role: u.role,
    email: row.email, locale: 'fr',
  });
  return NextResponse.redirect(new URL('/fr', req.url));
}
