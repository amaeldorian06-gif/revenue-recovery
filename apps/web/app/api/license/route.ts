import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/session';
import { getEntitlement } from '../../../lib/licensing';

export const dynamic = 'force-dynamic';

/**
 * GET /api/license — the minimal status the frontend may display. Computed
 * from the session's workspace in the database; no client-supplied identity,
 * no internal records, no payment evidence. Protected operations do NOT rely
 * on this endpoint: they run their own entitlement check server-side.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const ent = await getEntitlement(session);
  return NextResponse.json(
    {
      product: ent.productId,
      status: ent.status,
      access_allowed: ent.accessAllowed,
      expires_at: ent.expiresAt,
      reason: ent.reasonCode,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
