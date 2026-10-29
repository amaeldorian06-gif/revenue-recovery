import { NextResponse } from 'next/server';
import { asAdmin } from '../../../lib/db';
import { getSession } from '../../../lib/session';
import { markDeleted } from '@rros/db/gdpr';

export const dynamic = 'force-dynamic';

/**
 * DELETE /api/me — owner-only soft delete. All access dies with the workspace
 * (getSession refuses deleted workspaces), the nightly purge finishes the job
 * in 30 days. The typed-name confirmation lives in the settings form; this
 * endpoint is the machine-facing surface of the same guarantee.
 */
export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (session.role !== 'owner') return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const purgeAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await asAdmin((db) => markDeleted(db, session.workspaceId, purgeAt));
  return NextResponse.json({ ok: true, purgeAt: purgeAt.toISOString() });
}
