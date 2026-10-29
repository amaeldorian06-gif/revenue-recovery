'use server';

import { redirect } from 'next/navigation';
import { asAdmin, getDb, withTenant } from '../db';
import { getSession } from '../session';
import { encryptSecret, decryptSecret } from '@rros/domain/inbox/secretBox';
import { assertEntitlement, getUsage } from '@rros/db/billing';
import { connectMailbox, disconnectMailbox, type SyncOutcome } from '@rros/db/inbox';

/**
 * Mailbox management. The entitlement (plan limit) is enforced here — server
 * side, plan re-read from the database — before anything is stored, and the
 * credentials are encrypted before they touch a column.
 */

export async function connectSmtpMailboxAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const locale = session.locale;
  const host = String(formData.get('host') ?? '').trim();
  const port = Number(formData.get('port') ?? 993);
  const user = String(formData.get('user') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  const email = String(formData.get('email') ?? user).trim();

  if (!host || !user || !password) redirect(`/${locale}/settings?error=mailbox_fields`);
  if (password.length < 8) redirect(`/${locale}/settings?error=mailbox_password`);

  const { decision } = await asAdmin((db) => assertEntitlement(db, session.workspaceId, 'connect_mailbox'));
  if (!decision.allowed) redirect(`/${locale}/settings?error=mailbox_limit`);

  await asAdmin((db) =>
    connectMailbox(db, session.workspaceId, {
      provider: 'smtp_imap',
      email,
      credentials: { host, port: Number.isFinite(port) ? port : 993, user, password, tls: true },
    }),
  );
  await withTenant(session.workspaceId, async (db) => {
    await patchOnboardingMailbox(db, session.workspaceId);
  });
  redirect(`/${locale}/settings?mailbox=connected`);
}

async function patchOnboardingMailbox(db: Awaited<ReturnType<typeof getDb>>, workspaceId: string): Promise<void> {
  const { patchOnboardingState } = await import('@rros/db/onboarding');
  await patchOnboardingState(db, workspaceId, { stepDone: 'mailbox' });
}

export async function connectSandboxMailboxAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const { decision } = await asAdmin((db) =>
    assertEntitlement(db, session.workspaceId, 'connect_mailbox'),
  );
  if (!decision.allowed) redirect(`/${session.locale}/settings?error=mailbox_limit`);
  await asAdmin((db) =>
    connectMailbox(db, session.workspaceId, {
      provider: 'sandbox', email: session.email,
    }),
  );
  redirect(`/${session.locale}/settings?mailbox=sandbox`);
}

export async function disconnectMailboxAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const mailboxId = String(formData.get('mailboxId') ?? '');
  if (!mailboxId) redirect(`/${session.locale}/settings?error=mailbox_missing`);
  await asAdmin((db) => disconnectMailbox(db, session.workspaceId, mailboxId));
  redirect(`/${session.locale}/settings?mailbox=disconnected`);
}

export async function toggleStoreBodyAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const enable = formData.get('store_body') === 'on';
  await asAdmin((db) =>
    db.query('update workspaces set store_body = $2 where id = $1::uuid',
      [session.workspaceId, enable]),
  );
  await asAdmin((db) =>
    db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'privacy.store_body', 'workspace', $1::text, $2::jsonb)`,
      [session.workspaceId, JSON.stringify({ store_body: enable })],
    ),
  );
  redirect(`/${session.locale}/settings?privacy=saved`);
}

export interface MailboxView {
  id: string;
  provider: 'gmail_oauth' | 'smtp_imap' | 'sandbox';
  status: string;
  email: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export async function listMailboxes(workspaceId: string): Promise<MailboxView[]> {
  const db = await getDb();
  const r = await asAdmin((conn) =>
    conn.query<{
      id: string; provider: MailboxView['provider']; status: string; email_address: string | null;
      last_sync_at: string | null; last_error: string | null; last_error_at: string | null;
    }>(
      `select id, provider, status, email_address, last_sync_at, last_error, last_error_at
         from mailbox_connections
        where workspace_id = $1::uuid
        order by created_at`,
      [workspaceId],
    ),
  );
  return r.rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    status: row.status,
    email: row.email_address,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
    lastError: row.last_error,
    lastErrorAt: row.last_error_at ? new Date(row.last_error_at) : null,
  }));
}

export async function syncNowAction(): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  // Runs the same engine as the cron, once, for this workspace's oldest mailbox.
  const db = await getDb();
  const { loadMailboxForSync, syncMailbox } = await import('@rros/db/inbox');
  const { sandboxMail } = await import('@rros/domain/inbox/provider');
  const mailbox = await asAdmin((conn) => loadMailboxForSync(conn));
  if (!mailbox || mailbox.workspaceId !== session.workspaceId) {
    redirect(`/${session.locale}/settings?mailbox=idle`);
  }
  const storeBody = await asAdmin((conn) =>
    conn.query<{ store_body: boolean }>('select store_body from workspaces where id = $1::uuid', [session.workspaceId]),
  );
  const creds = mailbox!.credentials ? decryptSecret(mailbox!.credentials) : null;
  const outcome: SyncOutcome = await asAdmin((conn) =>
    syncMailbox(conn, { ...mailbox!, credentials: creds }, sandboxMail(), {
      storeBody: storeBody.rows[0]?.store_body === true,
    }),
  );
  redirect(`/${session.locale}/settings?mailbox=${outcome.status}`);
}

export async function storeBodyEnabled(workspaceId: string): Promise<boolean> {
  const db = await getDb();
  const r = await asAdmin((conn) =>
    conn.query<{ store_body: boolean }>('select store_body from workspaces where id = $1::uuid', [workspaceId]),
  );
  return r.rows[0]?.store_body === true;
}

export async function usageSeats(workspaceId: string): Promise<number> {
  const db = await getDb();
  const usage = await asAdmin((conn) => getUsage(conn, workspaceId));
  return usage.mailboxes;
}

/** Recent privacy-relevant events for the settings audit view (no contents). */
export interface AuditEvent {
  action: string;
  entity: string;
  entityId: string | null;
  createdAt: Date;
}

const AUDIT_ACTIONS = [
  'contact.opt_out', 'bounce.alerted', 'reply.bounce', 'mailbox.revoked', 'retention.purged',
];

export async function recentAuditEvents(workspaceId: string): Promise<AuditEvent[]> {
  const db = await getDb();
  return asAdmin(async (conn) => {
    const r = await conn.query<{
      action: string; entity: string; entity_id: string | null; created_at: string;
    }>(
      `select action, entity, entity_id, created_at
         from audit_log
        where workspace_id = $1::uuid and action = any($2::text[])
        order by created_at desc limit 12`,
      [workspaceId, AUDIT_ACTIONS],
    );
    return r.rows.map((e) => ({
      action: e.action,
      entity: e.entity,
      entityId: e.entity_id,
      createdAt: new Date(e.created_at),
    }));
  });
}
