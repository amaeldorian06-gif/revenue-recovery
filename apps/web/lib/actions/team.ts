'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { asAdmin, getDb } from '../db';
import { getSession } from '../session';
import { createSession } from '../session';
import { can } from '@rros/domain/authz/can';
import {
  inviteMember, removeMember, acceptInvitation, createApiKey, revokeApiKey,
  createWebhookEndpoint, deleteWebhookEndpoint, enqueueWebhook,
  listWebhookEndpoints, SeatLimitReachedError,
} from '@rros/db/team';
import { scopesForPlan, ALL_SCOPES } from '@rros/domain/authz/scopes';
import { randomUUID } from 'node:crypto';
import { buildExport } from '../gdpr';

/**
 * Team & integrations actions. The permission matrix (can.ts) gates every
 * mutation; seats are enforced on ACCEPTANCE, not on invitation.
 */

async function requireAbility(
  action: Parameters<typeof can>[1],
  ownerUserId?: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getSession>>>> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const decision = can(
    { role: session.role, userId: session.userId, ownerUserId },
    action,
  );
  if (!decision.allowed) redirect(`/${session.locale}/settings?team=${decision.reasonCode ?? 'forbidden'}`);
  return session;
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const session = await requireAbility('invite:member');
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const roleInput = String(formData.get('role') ?? 'member');
  const role = (['admin', 'member', 'viewer'] as const).includes(roleInput as 'member')
    ? (roleInput as 'admin' | 'member' | 'viewer')
    : 'member';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    redirect(`/${session.locale}/settings?team=email_invalid`);
  }
  try {
    const invite = await asAdmin((db) =>
      inviteMember(db, session.workspaceId, session.userId, { email, role, locale: session.locale }),
    );
    // No transactional provider in the sandbox: the invitation link is shown
    // once in the UI, exactly like an API key, and audit-logged.
    redirect(`/${session.locale}/settings?invited=${encodeURIComponent(invite.inviteUrlPath)}`);
  } catch (err) {
    if (err instanceof SeatLimitReachedError) {
      redirect(`/${session.locale}/settings?team=SEAT_LIMIT_REACHED`);
    }
    throw err;
  }
}

export async function removeMemberAction(formData: FormData): Promise<void> {
  const session = await requireAbility('invite:member');
  const userId = String(formData.get('userId') ?? '');
  const done = await asAdmin((db) => removeMember(db, session.workspaceId, session.userId, userId));
  redirect(`/${session.locale}/settings?team=${done ? 'member_removed' : 'member_undeletable'}`);
}

/** Accept an invitation: the seat limit bites here. Session rotated on entry. */
export async function acceptInviteAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const outcome = await asAdmin((db) => acceptInvitation(db, token));
  const locale = formData.get('locale') === 'en' ? 'en' : 'fr';
  if (!outcome.ok || !outcome.userId || !outcome.workspaceId) {
    redirect(`/${locale}/invite/failed?reason=${outcome.error ?? 'unknown'}`);
  }
  const row = await asAdmin((db) =>
    db.query<{ email: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>(
      'select email, role::text as role from users where id = $1::uuid',
      [outcome.userId],
    ),
  );
  // Fresh session = session rotation at the privilege change.
  await createSession({
    userId: outcome.userId, workspaceId: outcome.workspaceId,
    role: row.rows[0]!.role, email: row.rows[0]!.email, locale,
  });
  redirect(`/${locale}`);
}

export async function createApiKeyAction(formData: FormData): Promise<void> {
  const session = await requireAbility('manage:billing');
  const name = String(formData.get('name') ?? '').trim() || 'clé';
  const db = await getDb();
  const plan = await asAdmin((c) =>
    c.query<{ plan: 'starter' | 'growth' | 'scale' }>('select plan::text as plan from workspaces where id = $1::uuid',
      [session.workspaceId]),
  );
  const scopes = scopesForPlan(plan.rows[0]?.plan ?? 'starter').slice();
  if (scopes.length === 0) {
    redirect(`/${session.locale}/settings?api=PLAN_FEATURE_UNAVAILABLE`);
  }
  const created = await asAdmin((c) => createApiKey(c, session.workspaceId, { name, scopes }));
  // The key is carried ONCE through the URL fragment-free redirect target and
  // surfaced from the search param by the page, then never again.
  redirect(`/${session.locale}/settings?api_key_created=${encodeURIComponent(created.key)}`);
}

export async function revokeApiKeyAction(formData: FormData): Promise<void> {
  const session = await requireAbility('manage:billing');
  const keyId = String(formData.get('keyId') ?? '');
  await asAdmin((db) => revokeApiKey(db, session.workspaceId, keyId));
  revalidatePath(`/${session.locale}/settings`);
  redirect(`/${session.locale}/settings?api=revoked`);
}

export async function createWebhookAction(formData: FormData): Promise<void> {
  const session = await requireAbility('manage:mailbox');
  const url = String(formData.get('url') ?? '').trim();
  const events = ALL_SCOPES.length ? ['action.sent', 'reply.received', 'opportunity.won', 'opportunity.expired', 'weekly.snapshot', 'usage.threshold']
    : [];
  const wanted = String(formData.get('events') ?? 'reply.received').split(',').map((e) => e.trim());
  const chosen = wanted.filter((e) => events.includes(e));
  if (!url || chosen.length === 0) {
    redirect(`/${session.locale}/settings?webhook=invalid`);
  }
  try {
    const created = await asAdmin((db) =>
      createWebhookEndpoint(db, session.workspaceId, url, chosen, {
        devLoopback: process.env.RROS_DEV_SEED === '1',
      }),
    );
    redirect(`/${session.locale}/settings?webhook_secret=${encodeURIComponent(created.secret)}`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('SSRF_BLOCKED')) {
      redirect(`/${session.locale}/settings?webhook=ssrf_blocked`);
    }
    throw err;
  }
}

export async function deleteWebhookAction(formData: FormData): Promise<void> {
  const session = await requireAbility('manage:mailbox');
  const endpointId = String(formData.get('endpointId') ?? '');
  await asAdmin((db) => deleteWebhookEndpoint(db, session.workspaceId, endpointId));
  redirect(`/${session.locale}/settings?webhook=removed`);
}

/** "Envoyer un événement de test" — without it, nobody integrates. */
export async function testWebhookAction(formData: FormData): Promise<void> {
  const session = await requireAbility('manage:mailbox');
  const endpointId = String(formData.get('endpointId') ?? '');
  const db = await getDb();
  const endpoints = await asAdmin((c) => listWebhookEndpoints(c, session.workspaceId));
  if (!endpoints.some((e) => e.id === endpointId)) {
    redirect(`/${session.locale}/settings?webhook=unknown`);
  }
  // Bypass the subscription filter: a test must reach its endpoint even when
  // the workspace subscribes to no event yet.
  await asAdmin((c) =>
    c.query(
      `insert into webhook_deliveries (workspace_id, endpoint_id, event, payload)
       values ($1::uuid, $2::uuid, 'reply.received', $3::jsonb)`,
      [session.workspaceId, endpointId,
       JSON.stringify({ id: randomUUID(), event: 'reply.received', test: true, at: new Date().toISOString() })],
    ),
  );
  // Kick the dispatcher once so the user sees the result immediately.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    await fetch(new URL('/api/cron/webhooks', process.env.APP_URL ?? 'http://localhost:3000'), {
      method: 'POST', headers: { authorization: `Bearer ${secret}` },
    }).catch(() => undefined);
  }
  redirect(`/${session.locale}/settings?webhook=test_queued`);
}

export async function deleteWorkspaceAction(_prev: unknown, formData: FormData): Promise<{ error?: string }> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  if (session.role !== 'owner') return { error: 'ROLE_FORBIDDEN' };
  const db = await getDb();
  const name = await asAdmin((c) =>
    c.query<{ name: string }>('select name from workspaces where id = $1::uuid', [session.workspaceId]),
  );
  const typed = String(formData.get('confirm') ?? '').trim();
  if (typed !== name.rows[0]?.name) return { error: 'name_mismatch' };
  const purgeAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await asAdmin((c) =>
    c.query(
      `update workspaces set deleted_at = now(), purge_at = $2::timestamptz where id = $1::uuid`,
      [session.workspaceId, purgeAt.toISOString()],
    ),
  );
  await asAdmin((c) =>
    c.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'workspace.deleted', 'workspace', $1::text, $3::jsonb)`,
      [session.workspaceId, session.userId, JSON.stringify({ purgeAt: purgeAt.toISOString() })],
    ),
  );
  redirect(`/${session.locale}/deleted`);
}

export async function requestExportAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const decision = can({ role: session.role, userId: session.userId }, 'export:workspace');
  if (!decision.allowed) redirect(`/${session.locale}/settings?export=ROLE_FORBIDDEN`);
  const exportResult = await buildExport(session.workspaceId, session.userId, session.locale);
  redirect(`/${session.locale}/settings?export=ready&file=${encodeURIComponent(exportResult.downloadPath)}`);
}

export async function usageThresholdCheck(workspaceId: string): Promise<void> {
  // Called by import & send paths when a counter crosses 80 % or 100 %.
  await asAdmin((db) => enqueueWebhook(db, workspaceId, 'usage.threshold', {
    id: randomUUID(), event: 'usage.threshold', threshold: 'check',
  }));
}
