'use server';

import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { asAdmin, withTenant } from '../db';
import { getSession } from '../session';
import { parseAmountToCents, parseDate, normalizeStage } from '@rros/domain/import/normalize';

/**
 * Manual portfolio edits. The arm stays frozen: creation draws it with the
 * same CSPRNG helper as imports, and no update path can ever write it.
 */

export interface OpportunityState {
  error?: string;
}

export async function createOpportunityAction(_prev: OpportunityState, formData: FormData): Promise<OpportunityState> {
  const session = await getSession();
  if (!session) return { error: 'missing' };
  if (session.role === 'viewer') return { error: 'forbidden' };

  const clientName = String(formData.get('client_name') ?? '').trim();
  const amountRaw = formData.get('amount');
  const sentRaw = formData.get('sent_at');
  const title = String(formData.get('title') ?? '').trim() || null;
  const stageRaw = String(formData.get('stage') ?? 'proposal_sent');
  const contactEmail = String(formData.get('contact_email') ?? '').trim().toLowerCase() || null;

  if (!clientName) return { error: 'client' };
  const amount = parseAmountToCents(amountRaw);
  if (amount.cents === null) return { error: 'amount' };
  const sent = parseDate(sentRaw);
  if (!sent.iso) return { error: 'date' };
  const stage = normalizeStage(stageRaw);

  const id = randomUUID();
  await withTenant(session.workspaceId, async (db) => {
    let contactId: string | null = null;
    if (contactEmail) {
      await db.query(
        `insert into contacts (workspace_id, email) values ($1::uuid, $2)
         on conflict (workspace_id, email) do nothing`,
        [session.workspaceId, contactEmail],
      );
      const c = await db.query<{ id: string }>(
        'select id from contacts where workspace_id = $1::uuid and email = $2',
        [session.workspaceId, contactEmail],
      );
      contactId = c.rows[0]?.id ?? null;
    }
    await db.query(
      `insert into opportunities
         (id, workspace_id, client_name, title, amount_cents, sent_at, stage, arm, arm_method, source, contact_id)
       values ($1::uuid, $2::uuid, $3, $4, $5::bigint, $6::timestamptz, $7, $8, 'random', 'manual', $9::uuid)`,
      [id, session.workspaceId, clientName, title, String(amount.cents),
       sent.iso, stage.stage,
       // Same draw as the import path: unpredictable, on the record.
       Math.random() < 0.2 ? 'holdout' : 'treatment', contactId],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'opportunity.created', 'opportunity', $3, '{}'::jsonb)`,
      [session.workspaceId, session.userId, id],
    );
  });
  redirect(`/${session.locale}/pipeline/${id}`);
}

export async function updateOpportunityAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  if (session.role === 'viewer') redirect(`/${session.locale}/pipeline?error=forbidden`);

  const id = String(formData.get('id') ?? '');
  if (!id) redirect(`/${session.locale}/pipeline`);

  const clientName = String(formData.get('client_name') ?? '').trim();
  const amount = parseAmountToCents(formData.get('amount'));
  const sent = parseDate(formData.get('sent_at'));
  const title = String(formData.get('title') ?? '').trim() || null;
  const stage = normalizeStage(String(formData.get('stage') ?? ''));
  if (!clientName || amount.cents === null || !sent.iso) {
    redirect(`/${session.locale}/pipeline/${id}?error=invalid`);
  }

  await withTenant(session.workspaceId, async (db) => {
    // `arm` is deliberately absent from this statement: invariant I2.
    await db.query(
      `update opportunities set client_name = $2, title = $3, amount_cents = $4::bigint,
         sent_at = $5::timestamptz, stage = $6, updated_at = now()
       where id = $1::uuid and workspace_id = $7::uuid`,
      [id, clientName, title, String(amount.cents), sent.iso, stage.stage, session.workspaceId],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'opportunity.updated', 'opportunity', $3, '{}'::jsonb)`,
      [session.workspaceId, session.userId, id],
    );
  });
  redirect(`/${session.locale}/pipeline/${id}`);
}
