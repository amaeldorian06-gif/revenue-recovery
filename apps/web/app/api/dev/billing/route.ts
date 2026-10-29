import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { getSession } from '../../../../lib/session';
import { seedDemo, patchOnboardingState, getOnboardingState } from '@rros/db/onboarding';
import { recordFunnel, resetUsage } from '@rros/db/billing';
import { generateQueue } from '@rros/db/queue';

export const dynamic = 'force-dynamic';

/**
 * DEV ONLY (like /api/dev/seed). Lets the end-to-end flow drive the parts of
 * onboarding and metering that are server actions — which need a browser —
 * without inventing a second production surface. Disabled in production and
 * without RROS_DEV_SEED=1.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: 'demo' | 'usage' | 'queue' | 'funnel' | 'state';
    proposals?: number;
  };

  if (body.action === 'demo') {
    const out = await asAdmin((db) => seedDemo(db, session.workspaceId, { userId: session.userId }));
    await asAdmin(async (db) => {
      await patchOnboardingState(db, session.workspaceId, { stepDone: 'import', step: 4 });
      await recordFunnel(db, session.workspaceId, session.userId, 'import_confirmed');
    });
    return NextResponse.json({ ok: true, ...out });
  }

  if (body.action === 'usage') {
    await asAdmin((db) => resetUsage(db, session.workspaceId));
    await asAdmin((db) =>
      db.query('update usage_counters set proposals_tracked = $2 where workspace_id = $1::uuid',
        [session.workspaceId, body.proposals ?? 0]),
    );
    return NextResponse.json({ ok: true, proposals: body.proposals ?? 0 });
  }

  if (body.action === 'queue') {
    await asAdmin((db) => generateQueue(db, { workspaceId: session.workspaceId, date: new Date() }));
    await asAdmin(async (db) => {
      const { markFirstQueue } = await import('@rros/db/onboarding');
      await markFirstQueue(db, session.workspaceId);
      await recordFunnel(db, session.workspaceId, session.userId, 'queue_generated');
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'funnel') {
    await asAdmin(async (db) => {
      for (const name of ['mailbox_step_done', 'calibration_seen']) {
        await recordFunnel(db, session.workspaceId, session.userId, name);
      }
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'state') {
    return NextResponse.json({ ok: true, state: await asAdmin((db) => getOnboardingState(db, session.workspaceId)) });
  }

  return NextResponse.json({ error: 'unknown_action' }, { status: 400 });
}
