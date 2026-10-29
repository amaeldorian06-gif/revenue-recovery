import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/session';
import { withTenant } from '../../../../lib/db';
import { generateQueue } from '@rros/db/queue';
import { can } from '@rros/domain/authz';

export const dynamic = 'force-dynamic';

/**
 * 10 regenerations per minute per workspace.
 *
 * In memory on purpose for this phase: the product runs on a single Node process
 * until phase 08 puts it behind a queue. The limitation is documented rather than
 * hidden — behind two instances this counter doubles (DECISIONS.md #13).
 */
const WINDOW_MS = 60_000;
const LIMIT = 10;
const hits = new Map<string, number[]>();

function rateLimited(workspaceId: string): boolean {
  const now = Date.now();
  const recent = (hits.get(workspaceId) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(workspaceId, recent);
  if (hits.size > 5_000) hits.clear(); // unbounded growth guard
  return recent.length > LIMIT;
}

export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  // Regenerating rewrites the day's rows: an edit on the pipeline, never a read.
  if (!can({ role: session.role, userId: session.userId }, 'edit:opportunity').allowed) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (rateLimited(session.workspaceId)) {
    return NextResponse.json({ error: 'rate_limited', retryAfterSeconds: 60 }, { status: 429 });
  }

  const result = await withTenant(session.workspaceId, (db) =>
    generateQueue(db, { workspaceId: session.workspaceId, date: new Date() }),
  );

  return NextResponse.json({ ok: true, ...result }, { headers: { 'cache-control': 'no-store' } });
}
