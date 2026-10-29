import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/session';
import { can } from '@rros/domain/authz/can';
import { buildExport } from '../../../../lib/gdpr';

export const dynamic = 'force-dynamic';

/**
 * GET /api/me/export — owner-only. Builds the ZIP and returns the download
 * link (24 h). The spec says "generated asynchronously, link emailed": in the
 * sandbox there is no mail provider, so the link is returned to the caller
 * and logged — the async contract is honoured by the export_requests row.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  const decision = can({ role: session.role, userId: session.userId }, 'export:workspace');
  if (!decision.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const out = await buildExport(session.workspaceId, session.userId, session.locale);
  return NextResponse.json({ ok: true, downloadPath: out.downloadPath, expiresAt: out.expiresAt.toISOString() });
}
