import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withSession } from '../../../../../lib/api';
import { withTenant } from '../../../../../lib/db';
import { approveDraft } from '@rros/db/actions';
import { can } from '@rros/domain/authz/can';
import { STOP_RULES } from '@rros/domain/sending/stopRules';

export const dynamic = 'force-dynamic';

const Body = z.object({
  finalText: z.string().min(1).max(4000),
  subject: z.string().max(200).optional(),
  /** ISO instant chosen by the user; defaults to now. */
  scheduledFor: z.string().datetime().optional(),
});

/**
 * Approving is not sending. This route writes the approved row and stops; the job
 * sends. A double click here creates nothing twice (partial unique index on
 * `parent_action_id`), and no click can ever reach a provider.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withSession(async (session) => {
    const decision = can({ role: session.role, userId: session.userId }, 'approve:own');
    if (!decision.allowed) {
      return NextResponse.json({ error: 'forbidden', reason: decision.reasonCode }, { status: 403 });
    }
    const { id } = await params;
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
    }

    const result = await withTenant(session.workspaceId, (db) =>
      approveDraft(db, {
        draftActionId: id,
        workspaceId: session.workspaceId,
        userId: session.userId,
        finalText: parsed.data.finalText,
        subject: parsed.data.subject ?? null,
        scheduledFor: parsed.data.scheduledFor ? new Date(parsed.data.scheduledFor) : new Date(),
        now: new Date(),
      }),
    ).catch((err: unknown) => {
      // A second click on the same draft hits the partial unique index. That is a
      // conflict, not a crash: the client can treat 409 as "already approved".
      const message = err instanceof Error ? err.message : '';
      if (message.includes('actions_one_approval')) return 'already_approved' as const;
      throw err;
    });

    if (result === 'already_approved') {
      return NextResponse.json({ error: 'already_approved' }, { status: 409 });
    }
    if (!result) return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });

    const next = new Date(new Date(result.scheduledFor).getTime() + STOP_RULES.MIN_DAYS_BETWEEN_TOUCHES * 86_400_000);
    return NextResponse.json({
      ok: true,
      approvedActionId: result.approvedActionId,
      editRatio: result.editRatio,
      scheduledFor: result.scheduledFor,
      nextFollowUpAt: next.toISOString(),
    });
  });
}
