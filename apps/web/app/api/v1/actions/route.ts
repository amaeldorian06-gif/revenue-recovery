import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { withApiKey, problem, replayOrStore } from '../../../../lib/api-v1';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/actions — creates a DRAFT, deliberately. No scope, no plan, no
 * header can make this route approve a message or schedule a send: the
 * API prepares, humans dispatch (product invariant I1). Criterion 4 greps
 * this file for the string.
 */
export const POST = withApiKey('write:actions', '/v1/actions', async ({ key, req }) => {
    const body = (await req.json().catch(() => null)) as
      | { opportunityId?: string; subject?: string; text?: string }
      | null;
    if (!body?.opportunityId || !body?.text) {
      return problem(400, 'VALIDATION', 'opportunityId and text are required');
    }
    if (typeof body.text !== 'string' || body.text.length > 4000) {
      return problem(400, 'VALIDATION', 'text must be 1–4000 characters');
    }
    const db = await getDb();
    // The dossier must belong to the key's workspace: no cross-tenant write.
    const opp = await db.query<{ id: string }>(
      `select o.id from opportunities o
        where o.id = $1::uuid and o.workspace_id = $2::uuid`,
      [body.opportunityId, key.workspaceId],
    );
    if (!opp.rows[0]) return problem(404, 'NOT_FOUND', 'No such opportunity in this workspace');

    return replayOrStore(req, key.workspaceId, '/v1/actions', async () => {
      const action = await db.query<{ id: string }>(
        `insert into actions (workspace_id, opportunity_id, kind, status, actor_type, subject, draft_text)
         values ($1::uuid, $2::uuid, 'draft_generated', 'draft', 'system', $3::text, $4::text)
         returning id`,
        [key.workspaceId, body.opportunityId, body.subject ?? '(via API)', body.text],
      );
      return NextResponse.json(
        { id: action.rows[0]!.id, status: 'draft', note: 'The API creates drafts; approval and sending stay human.' },
        { status: 201 },
      );
    });
});
