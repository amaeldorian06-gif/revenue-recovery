import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { getSession } from '../../../../lib/session';
import { createApiKey, createWebhookEndpoint } from '@rros/db/team';

export const dynamic = 'force-dynamic';

/**
 * DEV ONLY (RROS_DEV_SEED=1) — drives the phase-08 flows without the UI:
 * creates an API key and a webhook endpoint aimed at the local test
 * receiver. Everything else runs through the real v1 routes and the real
 * webhook cron.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    plan?: 'starter' | 'growth' | 'scale';
    receiverFail?: number;
    enqueueTest?: boolean;
    member?: { role: 'admin' | 'member' | 'viewer'; email?: string };
  };
  const fail = body.receiverFail ? `?fail=${body.receiverFail}` : '';

  return asAdmin(async (conn) => {
    if (body.member) {
      // Dev shortcut for the permission-matrix HTTP flow: create the user
      // directly and mint a session token, bypassing the invitation (which the
      // team flow tests separately, through the real UI path).
      const { role } = body.member;
      const email = (body.member.email ?? `dev-${role}-${crypto.randomUUID().slice(0, 8)}@agence-bellamy.fr`).toLowerCase();
      const userId = crypto.randomUUID();
      await conn.query(
        `insert into users (id, auth_user_id, workspace_id, email, full_name, role)
         values ($1::uuid, $2, $3::uuid, $4, $5, $6)`,
        [userId, `local:${email}`, session.workspaceId, email, `Dev ${role}`, role],
      );
      // Through the REAL session layer: the token carries a sid backed by a
      // sessions row —getSession refuses sid-less tokens since 0010.
      const { mintSession } = await import('../../../../lib/session');
      const { token } = await mintSession({
        userId, workspaceId: session.workspaceId, role, email, locale: 'fr',
      });
      return NextResponse.json({ ok: true, email, role, token });
    }
    if (body.plan) {
      await conn.query(`update workspaces set plan = $2::text where id = $1::uuid`, [session.workspaceId, body.plan]);
    }
    const scopesByPlan: Record<string, string[]> = {
      starter: [],
      growth: ['read:opportunities', 'read:results'],
      scale: ['read:opportunities', 'write:actions', 'read:results'],
    };
    const plan = await conn.query<{ plan: 'starter' | 'growth' | 'scale' }>(
      'select plan::text as plan from workspaces where id = $1::uuid', [session.workspaceId],
    );
    if (!plan.rows[0]) {
      return NextResponse.json({ error: 'workspace_missing', workspaceId: session.workspaceId ?? null }, { status: 400 });
    }
    const scopes = scopesByPlan[plan.rows[0].plan] ?? [];
    const key = scopes.length > 0
      ? await createApiKey(conn, session.workspaceId, { name: 'demo', scopes })
      : null;
    const endpoint = await createWebhookEndpoint(
      conn, session.workspaceId,
      `http://127.0.0.1:3000/api/dev/hook-receiver${fail}`,
      ['action.sent', 'reply.received', 'opportunity.won', 'opportunity.expired', 'weekly.snapshot', 'usage.threshold'],
      { devLoopback: true },
    );
    let enqueued = 0;
    if (body.enqueueTest) {
      // Same insert the settings "test event" action performs.
      const r = await conn.query(
        `insert into webhook_deliveries (workspace_id, endpoint_id, event, payload)
         select $1::uuid, e.id, 'reply.received', '{"test":true,"event":"reply.received"}'::jsonb
           from webhook_endpoints e
          where e.workspace_id = $1::uuid and e.id = $2::uuid
          returning id`,
        [session.workspaceId, endpoint.id],
      );
      enqueued = r.rows.length;
    }
    return NextResponse.json({
      ok: true, plan: plan.rows[0]!.plan, key: key?.key ?? null, scopes,
      endpointId: endpoint.id, endpointSecret: endpoint.secret, enqueued,
    });
  });
}
