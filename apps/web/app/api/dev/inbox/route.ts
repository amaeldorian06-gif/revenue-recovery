import { NextResponse } from 'next/server';
import { asAdmin, getDb } from '../../../../lib/db';
import { getSession } from '../../../../lib/session';
import { sandboxMail, normalise } from '@rros/domain/inbox/provider';

export const dynamic = 'force-dynamic';

/**
 * DEV ONLY. Lets the end-to-end flow drive the sync path without a mail
 * server: delivers scripted messages into the workspace's sandbox mailbox,
 * sets up a dossier with a pending action, and inspects the resulting state —
 * everything else runs through the real cron routes. Disabled in production.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: 'deliver' | 'setup' | 'inspect' | 'disconnect' | 'break';
    from?: string;
    subject?: string;
    text?: string;
    to?: string;
    providerId?: string;
    threadId?: string;
    headers?: Record<string, string>;
    sentAt?: string;
    dossierId?: string;
  };
  const db = await getDb();

  if (body.action === 'setup') {
    return asAdmin(async (conn) => {
      const mb = await conn.query<{ id: string }>(
        `insert into mailbox_connections (workspace_id, provider, status, email_address)
         values ($1::uuid, 'sandbox', 'connected', $2)
         returning id`,
        [session.workspaceId, session.email],
      );
      // Two dossiers: one for the reply scenario (pending approved action), one
      // for the opt-out scenario. Each has a sent provider id to match on.
      const dossiers: Array<{ id: string; contactId: string; email: string }> = [];
      for (const email of ['marie.dupont@client-demo.fr', 'jean.martin@client-demo.fr']) {
        const c = await conn.query<{ id: string }>(
          `insert into contacts (workspace_id, email) values ($1::uuid, $2) returning id`,
          [session.workspaceId, email],
        );
        const o = await conn.query<{ id: string }>(
          `insert into opportunities (workspace_id, external_ref, client_name, contact_id, title,
                                      amount_cents, sent_at, status, arm, stage)
           values ($1::uuid, $2, $3, $4::uuid, 'Devis remboursement formation', 850000,
                   now() - interval '8 days', 'open', 'treatment', 'proposal_sent')
           returning id`,
          [session.workspaceId, `dev-inbox-${email.split('@')[0]}`, `Client ${email.split('@')[0]}`, c.rows[0]!.id],
        );
        const sentId = `<sent-${o.rows[0]!.id.slice(0, 8)}@rros>`;
        await conn.query(
          `insert into actions (workspace_id, opportunity_id, kind, status, actor_type, subject, provider, provider_message_id, sent_at)
           values ($1::uuid, $2::uuid, 'sent', 'sent', 'system', 'Devis remboursement formation', 'sandbox', $3, now())`,
          [session.workspaceId, o.rows[0]!.id, sentId],
        );
        await conn.query(
          `insert into mail_messages (workspace_id, mailbox_id, opportunity_id, direction, provider_id,
                                      from_email, subject, snippet, sent_at)
           values ($1::uuid, $2::uuid, $3::uuid, 'out', $4, $5, 'Devis remboursement formation', 'corps du devis…', now())`,
          [session.workspaceId, mb.rows[0]!.id, o.rows[0]!.id, sentId, session.email],
        );
        await conn.query(
          `insert into actions (workspace_id, opportunity_id, kind, status, actor_type, subject, draft_text, scheduled_for)
           values ($1::uuid, $2::uuid, 'approved', 'approved', 'user', 'Relance J+8', 'corps', now() + interval '1 hour')`,
          [session.workspaceId, o.rows[0]!.id],
        );
        dossiers.push({ id: o.rows[0]!.id, contactId: c.rows[0]!.id, email });
      }
      return NextResponse.json({
        ok: true, workspaceId: session.workspaceId, mailboxId: mb.rows[0]!.id,
        replyDossier: dossiers[0]!.id, optOutDossier: dossiers[1]!.id,
        replySentId: `<sent-${dossiers[0]!.id.slice(0, 8)}@rros>`,
        optOutSentId: `<sent-${dossiers[1]!.id.slice(0, 8)}@rros>`,
      });
    });
  }

  if (body.action === 'break') {
    return asAdmin(async (conn) => {
      await conn.query(
        `update mailbox_connections set last_error = $2, last_error_at = now()
          where workspace_id = $1::uuid and provider = 'sandbox' and revoked_at is null`,
        [session.workspaceId, 'IMAP authentication failed (dev-flow)'],
      );
      return NextResponse.json({ ok: true });
    });
  }

  if (body.action === 'disconnect') {
    return asAdmin(async (conn) => {
      await conn.query(
        `update mailbox_connections
            set status = 'disconnected', revoked_at = now(), credentials_encrypted = null,
                sync_cursor = null, last_error = null, last_error_at = null
          where workspace_id = $1::uuid and provider = 'sandbox' and revoked_at is null`,
        [session.workspaceId],
      );
      await conn.query(
        `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
         values ($1::uuid, 'user', 'mailbox.revoked', 'mailbox', $2::text, '{"source":"dev-flow"}'::jsonb)`,
        [session.workspaceId, session.workspaceId],
      );
      return NextResponse.json({ ok: true });
    });
  }

  if (body.action === 'inspect') {
    return asAdmin(async (conn) => {
      const dossierId = String(body.dossierId ?? '');
      const opp = await conn.query<{
        reply_received_at: string | null; opt_out_at: string | null; bounced_at: string | null;
        pending_cancelled: number | null; paused_scheduled: string | null;
        body_stored: boolean | null; messages: number;
      }>(
        `select o.reply_received_at, c.opt_out_at, c.bounced_at,
                (select count(*)::int from actions a
                  where a.opportunity_id = o.id and a.status = 'cancelled'
                    and a.rationale = 'reply_received') as pending_cancelled,
                (select max(a.scheduled_for)::text from actions a
                  where a.opportunity_id = o.id and a.status = 'approved') as paused_scheduled,
                (select count(*)::int from mail_messages m where m.opportunity_id = o.id) as messages,
                (select bool_or(m.body is not null) from mail_messages m where m.opportunity_id = o.id) as body_stored
           from opportunities o join contacts c on c.id = o.contact_id
          where o.id = $1::uuid and o.workspace_id = $2::uuid`,
        [dossierId, session.workspaceId],
      );
      if (opp.rows.length === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
      const alerts = await conn.query<{ n: number }>(
        `select count(*)::int as n from audit_log where workspace_id = $1::uuid and action = 'bounce.alerted'`,
        [session.workspaceId],
      );
      return NextResponse.json({ ok: true, ...opp.rows[0], bounceAlerts: alerts.rows[0]!.n });
    });
  }

  // default: deliver a message into the sandbox mailbox
  return asAdmin(async (conn) => {
    const mailbox = await conn.query<{ id: string }>(
      `select id from mailbox_connections
        where workspace_id = $1::uuid and provider = 'sandbox' and status = 'connected'
        order by created_at limit 1`,
      [session.workspaceId],
    );
    if (mailbox.rows.length === 0) {
      const created = await conn.query<{ id: string }>(
        `insert into mailbox_connections (workspace_id, provider, status, email_address)
         values ($1::uuid, 'sandbox', 'connected', $2) returning id`,
        [session.workspaceId, session.email],
      );
      mailbox.rows = created.rows;
    }
    const mailboxId = mailbox.rows[0]!.id;
    const storeBody = await conn.query<{ store_body: boolean }>(
      'select store_body from workspaces where id = $1::uuid', [session.workspaceId],
    );

    const raw = {
      providerId: body.providerId ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      threadId: body.threadId,
      from: body.from ?? 'client@exemple.fr',
      to: Array.isArray(body.to) ? body.to : [body.to ?? session.email],
      cc: [] as string[],
      subject: body.subject ?? 'Re: Devis remboursement formation',
      body: body.text ?? 'Bonjour, merci pour votre retour.',
      headers: body.headers ?? {},
      sentAt: body.sentAt ?? new Date().toISOString(),
      storeBody: storeBody.rows[0]?.store_body === true,
    };
    sandboxMail().deliver(mailboxId, normalise(raw));
    return NextResponse.json({ ok: true, mailboxId, providerId: raw.providerId });
  });
}
