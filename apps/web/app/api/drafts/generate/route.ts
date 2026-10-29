import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withSession } from '../../../../lib/api';
import { generateFor } from '../../../../lib/drafting';
import { can } from '@rros/domain/authz/can';

export const dynamic = 'force-dynamic';

const Body = z.object({
  opportunityId: z.string().uuid(),
  tone: z.enum(['warm', 'direct', 'formal']).default('warm'),
});

/**
 * Regeneration, tone switching included: same dossier, same context, one new
 * draft. A guardrail failure is a 200 with `draft: null` and a reason — the screen
 * has an answer to render, so it is not an error.
 */
export async function POST(req: Request) {
  return withSession(async (session) => {
    if (!can({ role: session.role, userId: session.userId }, 'approve:own').allowed) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body', detail: parsed.error.flatten() }, { status: 400 });
    }

    const draft = await generateFor(session, parsed.data.opportunityId, parsed.data.tone);
    return NextResponse.json({
      draft: draft.status === 'draft'
        ? {
            actionId: draft.actionId,
            subject: draft.subject,
            body: draft.body,
            tone: draft.tone,
            model: draft.model,
            promptVersion: draft.promptVersion,
          }
        : null,
      reason: draft.status === 'draft' ? null : (draft.reason ?? 'guardrail_failed'),
      violations: draft.violations,
      providerCalls: draft.providerCalls,
    });
  });
}
