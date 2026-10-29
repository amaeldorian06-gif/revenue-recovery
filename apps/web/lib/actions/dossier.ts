'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { asAdmin, withTenant } from '../db';
import { getSession } from '../session';
import { enqueueWebhook } from '@rros/db/team';
import { randomUUID } from 'node:crypto';

/**
 * Won / Lost in one click — available only once a reply exists (the user
 * decides what the reply means; the product never guesses). The undo window
 * is 10 seconds: `closed_at` is the clock, and the SQL guard makes the undo a
 * no-op past it — "définitivement" means something.
 */

export interface CloseResult {
  ok: boolean;
  status: 'won' | 'lost';
}

export async function closeOpportunityAction(
  _prev: CloseResult | null,
  formData: FormData,
): Promise<CloseResult | null> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const opportunityId = String(formData.get('opportunityId') ?? '');
  const status = String(formData.get('status') ?? '');
  if (status !== 'won' && status !== 'lost') redirect(`/${session.locale}?error=close_status`);

  const replied = await asAdmin((db) =>
    db.query<{ n: number }>(
      'select count(*)::int as n from opportunities where id = $1::uuid and workspace_id = $2::uuid and reply_received_at is not null',
      [opportunityId, session.workspaceId],
    ),
  );
  if ((replied.rows[0]?.n ?? 0) === 0) {
    // No reply → no one-click close: deciding without a reply is the card's job.
    redirect(`/${session.locale}/queue/${opportunityId}?error=close_no_reply`);
  }

  await withTenant(session.workspaceId, async (db) => {
    await db.query(
      `update opportunities set status = $2::text, closed_at = now(), updated_at = now()
        where id = $1::uuid`,
      [opportunityId, status],
    );
    await db.query(
      `insert into actions (workspace_id, opportunity_id, kind, status, actor_type, actor_user_id, rationale)
       values ($1::uuid, $2::uuid, 'cancelled', 'done', 'user', $3::uuid, $4)`,
      [session.workspaceId, opportunityId, session.userId, status === 'won' ? 'closed_won' : 'closed_lost'],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'opportunity.closed', 'opportunity', $3, $4::jsonb)`,
      [session.workspaceId, session.userId, opportunityId, JSON.stringify({ status })],
    );
    await enqueueWebhook(db, session.workspaceId, 'opportunity.won', {
      id: randomUUID(), event: 'opportunity.won',
      opportunityId, status,
    });
  });
  revalidatePath(`/${session.locale}`);
  return { ok: true, status };
}

export async function undoCloseOpportunityAction(
  _prev: { ok: boolean } | null,
  formData: FormData,
): Promise<{ ok: boolean } | null> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const opportunityId = String(formData.get('opportunityId') ?? '');
  await withTenant(session.workspaceId, async (db) => {
    await db.query(
      `update opportunities set status = 'open', closed_at = null, updated_at = now()
        where id = $1::uuid and closed_at is not null and closed_at > now() - interval '10 seconds'`,
      [opportunityId],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'opportunity.close_undone', 'opportunity', $3, '{}'::jsonb)`,
      [session.workspaceId, session.userId, opportunityId],
    );
  });
  revalidatePath(`/${session.locale}`);
  return { ok: true };
}

/** The two last messages of a dossier, snippets only unless body storage is on. */
export interface DossierMessage {
  id: string;
  direction: 'in' | 'out';
  fromEmail: string;
  subject: string;
  snippet: string;
  sentAt: Date;
  isBounce: boolean;
}

export async function lastMessages(opportunityId: string): Promise<DossierMessage[]> {
  const session = await getSession();
  if (!session) return [];
  return asAdmin(async (db) => {
    const r = await db.query<{
      id: string; direction: 'in' | 'out'; from_email: string; subject: string;
      snippet: string; sent_at: string; is_bounce: boolean;
    }>(
      `select id, direction, from_email, subject, snippet, sent_at, is_bounce
         from mail_messages
        where opportunity_id = $1::uuid and workspace_id = $2::uuid
        order by sent_at desc limit 2`,
      [opportunityId, session.workspaceId],
    );
    return r.rows.map((m) => ({
      id: m.id,
      direction: m.direction,
      fromEmail: m.from_email,
      subject: m.subject,
      snippet: m.snippet,
      sentAt: new Date(m.sent_at),
      isBounce: m.is_bounce,
    }));
  });
}
