import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { getSession } from '../../../../lib/session';
import {
  submitPaymentDeclaration, confirmPaymentAndActivateSubscription, expectedAmountCents,
  suspendSubscription, reactivateSubscription, getCurrentEntitlement,
} from '@rros/db/licensing';
import { getDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

/**
 * DEV ONLY — licensing recipe endpoints for the automated flows (the server
 * actions are browser-only, these mirror them one-to-one). Gated by
 * RROS_DEV_SEED like /api/dev/seed, so they can never ship as a backdoor.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    op?: string; plan?: 'starter' | 'growth' | 'scale'; currency?: 'EUR' | 'XAF';
    amount?: number; reference?: string; paymentId?: string; months?: number; workspaceId?: string;
  };
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  try {
    switch (body.op) {
      case 'declare': {
        const plan = body.plan ?? 'growth';
        const currency = body.currency ?? 'EUR';
        const db = await getDb();
        const r = await submitPaymentDeclaration(db, {
          workspaceId: session.workspaceId,
          userId: session.userId,
          plan,
          amountCents: body.amount ?? expectedAmountCents(plan, currency),
          currency,
          method: 'bank_transfer',
          externalReference: body.reference ?? `TR-${crypto.randomUUID().slice(0, 10)}`,
          now: new Date(),
        });
        return NextResponse.json(r, { status: r.ok ? 200 : 409 });
      }
      case 'confirm': {
        if (!body.paymentId) return NextResponse.json({ error: 'paymentId required' }, { status: 400 });
        const r = await asAdmin((db) =>
          confirmPaymentAndActivateSubscription(db, { paymentId: body.paymentId!, adminUserId: session.userId, now: new Date() }),
        );
        return NextResponse.json(r, { status: r.ok ? 200 : 409 });
      }
      case 'suspend': {
        const done = await asAdmin((db) =>
          suspendSubscription(db, body.workspaceId ?? session.workspaceId, session.userId, new Date()));
        return NextResponse.json({ ok: done }, { status: done ? 200 : 409 });
      }
      case 'reactivate': {
        const at = await asAdmin((db) =>
          reactivateSubscription(db, body.workspaceId ?? session.workspaceId, session.userId, new Date(), body.months ?? 1));
        return NextResponse.json({ ok: at !== null, expiresAt: at }, { status: at !== null ? 200 : 409 });
      }
      case 'entitlement': {
        const r = await asAdmin((db) =>
          getCurrentEntitlement(db, body.workspaceId ?? session.workspaceId, new Date()),
        );
        return NextResponse.json(r);
      }
      case 'revoke-admin': {
        await asAdmin((db) =>
          db.query(`update users set is_platform_admin = false where id = $1::uuid`, [session.userId]),
        );
        return NextResponse.json({ ok: true });
      }
      case 'end-trial': {
        // Dev recipe: a workspace outside its trial so licensing decides alone.
        await asAdmin((db) =>
          db.query(`update workspaces set subscription_status = 'canceled' where id = $1::uuid`,
            [body.workspaceId ?? session.workspaceId]),
        );
        return NextResponse.json({ ok: true });
      }
      case 'expire': {
        // Dev recipe: backdate the period so the lazy flip fires exactly as it
        // would a month after the last confirmation (the SQL a test would run).
        await asAdmin((db) =>
          db.query(`update subscriptions set expires_at = now() - interval '1 day'
                     where workspace_id = $1::uuid and product_id = 'revenue_recovery_os'`,
            [body.workspaceId ?? session.workspaceId]),
        );
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: 'unknown_op' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
