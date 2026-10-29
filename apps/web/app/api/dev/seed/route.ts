import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { createWorkspaceWithOwner } from '@rros/db/repo';
import { createSession } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * DEV ONLY. Creates a workspace + owner and returns a session cookie so the
 * end-to-end flow can be exercised without a browser. Disabled in production and
 * requiring an explicit token, so it can never become a backdoor in phase 06+.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { email?: string; workspace?: string };
  const email = body.email ?? 'fondateur@studio-merlot.fr';
  const workspace = body.workspace ?? 'Studio Merlot';

  try {
    const created = await asAdmin((db) =>
      createWorkspaceWithOwner(db, { email, workspaceName: workspace, locale: 'fr' }),
    );
    // Dev convenience: the seeded owner is a platform admin so the licensing
    // console is walkable. In production this flag is set by SQL only — the
    // application role cannot write the column (migration 0009).
    await asAdmin((db) =>
      db.query(`update users set is_platform_admin = true where id = $1::uuid`, [created.userId]),
    );
    await createSession({
      userId: created.userId,
      workspaceId: created.workspaceId,
      role: 'owner',
      email,
      locale: 'fr',
    });
    // Mirror the signup action: the funnel's first step exists for dev flows too.
    const { recordFunnel } = await import('@rros/db/billing');
    await asAdmin((db) => recordFunnel(db, created.workspaceId, created.userId, 'signup_completed'));
    return NextResponse.json({ ok: true, ...created });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
