import { NextResponse } from 'next/server';
import { getSession, type Session } from './session';
import { asAdmin, withTenant } from './db';
import {
  getCurrentEntitlement, PRODUCT_ID, type Entitlement,
} from '@rros/db/licensing';

/**
 * Licensing boundary helpers. Every protected surface goes through here —
 * there is no second licensing implementation anywhere else.
 *
 * The entitlement read runs on the privileged server path because it also
 * RECORDS the expiry transition (an `active` row past its `expires_at` is
 * flipped and audited once). Parameters are always taken from the verified
 * session, never from the request body.
 */

export async function getEntitlement(session: Session): Promise<Entitlement> {
  return asAdmin((db) => getCurrentEntitlement(db, session.workspaceId, new Date()));
}

/** API boundary: 401 unauthenticated, 403 without entitlement (code = why). */
export async function withEntitlement(
  fn: (session: Session) => Promise<Response>,
): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const ent = await getEntitlement(session);
  if (!ent.accessAllowed) {
    return NextResponse.json(
      { error: 'forbidden', code: ent.reasonCode, product: ent.productId, expiresAt: ent.expiresAt },
      { status: 403 },
    );
  }
  try {
    return await fn(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: 'server_error', message }, { status: 500 });
  }
}

/**
 * The platform administrator is a DATABASE fact, not a workspace role and not
 * a session claim: verified on every sensitive call, un-settable through the
 * application (the app role's UPDATE grant on users is column-scoped).
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const r = await asAdmin((db) =>
    db.query<{ ok: boolean }>(
      `select (u.is_platform_admin and w.deleted_at is null) as ok
         from users u join workspaces w on w.id = u.workspace_id
        where u.id = $1::uuid`,
      [userId],
    ),
  );
  return r.rows[0]?.ok === true;
}

export { PRODUCT_ID };
