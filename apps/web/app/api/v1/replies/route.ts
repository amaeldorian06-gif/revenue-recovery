import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { withApiKey, problem, replayOrStore } from '../../../../lib/api-v1';
import { enqueueWebhook } from '@rros/db/team';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

/**
 * POST /v1/replies — records a reply that arrived OUTSIDE the synced inbox
 * (a phone call follow-up email, an answer pasted by the team) and stops the
 * sequence exactly like the sync would: reply_received_at, pending actions
 * cancelled with reason reply_received, reply_detected action, webhook.
 */
export const POST = withApiKey('write:actions', '/v1/replies', async ({ key, req }) => {
    const body = (await req.json().catch(() => null)) as
      | { opportunityId?: string; fromEmail?: string; subject?: string; receivedAt?: string; snippet?: string }
      | null;
    if (!body?.opportunityId) {
      return problem(400, 'VALIDATION', 'opportunityId is required');
    }
    const db = await getDb();
    const opp = await db.query<{ id: string; reply_received_at: string | null }>(
      `select id, reply_received_at::text from opportunities
        where id = $1::uuid and workspace_id = $2::uuid`,
      [body.opportunityId, key.workspaceId],
    );
    if (!opp.rows[0]) return problem(404, 'NOT_FOUND', 'No such opportunity in this workspace');

    return replayOrStore(req, key.workspaceId, '/v1/replies', async () => {
      const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
      if (Number.isNaN(receivedAt.getTime())) {
        return problem(400, 'VALIDATION', 'receivedAt must be an ISO instant');
      }
      await db.query(
        `update opportunities
            set reply_received_at = coalesce(reply_received_at, $2::timestamptz), updated_at = now()
          where id = $1::uuid`,
        [body.opportunityId, receivedAt.toISOString()],
      );
      // Cancels everything pending — including actions a human had already
      // qualified — because a reply outranks any scheduled follow-up.
      const cancelled = await db.query<{ n: number }>(
        `with upd as (
           update actions set status = 'cancelled', rationale = 'reply_received'
            where opportunity_id = $2::uuid and workspace_id = $1::uuid
              and status in ('approved', 'draft') returning 1)
         select count(*)::int as n from upd`,
        [key.workspaceId, body.opportunityId],
      );
      await db.query(
        `insert into actions (workspace_id, opportunity_id, kind, status, actor_type)
         values ($1::uuid, $2::uuid, 'reply_detected', 'done', 'system')`,
        [key.workspaceId, body.opportunityId],
      );
      await db.query(
        `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
         values ($1::uuid, 'system', 'reply.received', 'opportunity', $2, $3::jsonb)`,
        [key.workspaceId, body.opportunityId,
         JSON.stringify({ source: 'api', cancelled: cancelled.rows[0]!.n })],
      );
      await enqueueWebhook(db, key.workspaceId, 'reply.received', {
        id: randomUUID(), event: 'reply.received',
        opportunityId: body.opportunityId, cancelledActions: cancelled.rows[0]!.n,
      });
      return NextResponse.json({ ok: true, cancelledActions: cancelled.rows[0]!.n }, { status: 201 });
    });
});
