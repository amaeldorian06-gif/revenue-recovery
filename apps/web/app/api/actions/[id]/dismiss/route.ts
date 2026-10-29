import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withSession } from '../../../../../lib/api';
import { withTenant } from '../../../../../lib/db';
import { dismissDraft } from '@rros/db/actions';
import { can } from '@rros/domain/authz/can';

export const dynamic = 'force-dynamic';

const Body = z.object({
  reason: z.enum(['not_relevant', 'already_answered_elsewhere', 'client_asked_to_stop', 'other']),
});

/** The reason is required: "dismissed" without a why teaches the product nothing. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(async (session) => {
    if (!can({ role: session.role, userId: session.userId }, 'approve:own').allowed) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const { id } = await params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body', reason: 'reason_required' }, { status: 400 });
    }
    await withTenant(session.workspaceId, (db) =>
      dismissDraft(db, {
        draftActionId: id, workspaceId: session.workspaceId, userId: session.userId,
        reason: parsed.data.reason, now: new Date(),
      }),
    );
    return NextResponse.json({
      ok: true,
      reason: parsed.data.reason,
      opportunityEffect:
        parsed.data.reason === 'not_relevant' ? 'dormant'
        : parsed.data.reason === 'client_asked_to_stop' ? 'opted_out'
        : null,
    });
  });
}
