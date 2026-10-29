import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withSession } from '../../../../../lib/api';
import { withTenant } from '../../../../../lib/db';
import { snoozeDraft } from '@rros/db/actions';
import { can } from '@rros/domain/authz/can';

export const dynamic = 'force-dynamic';

const Body = z.object({ days: z.number().int().min(1).max(30).default(7) });

/** Snooze is not a contact: `last_touch_at` is untouched (see repo/actions.ts). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(async (session) => {
    if (!can({ role: session.role, userId: session.userId }, 'approve:own').allowed) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const { id } = await params;
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }
    const now = new Date();
    await withTenant(session.workspaceId, (db) =>
      snoozeDraft(db, {
        draftActionId: id, workspaceId: session.workspaceId, userId: session.userId,
        now, days: parsed.data.days,
      }),
    );
    const until = new Date(now.getTime() + parsed.data.days * 86_400_000).toISOString();
    return NextResponse.json({ ok: true, until, days: parsed.data.days });
  });
}
