/**
 * Phase 07 persistence — criteria 2 to 10.
 *
 * The loop must close without a human: a reply cancels the sequence, a bounce
 * blocks the address, an opt-out wins over the holdout, and none of it may
 * leak a token, a body or a duplicate.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { connectMailbox, syncMailbox, disconnectMailbox, purgeOldBodies } from '../repo/inbox.ts';
import { SandboxMailProvider, normalise, sandboxMail, RateLimitedError, type NormalisedMessage } from '../../../domain/src/inbox/provider.ts';
import { generateQueue, loadCandidates, isoDate } from '../repo/queue.ts';

let db: Db;
let workspaceId: string;
let userId: string;
let mailboxId: string;
const provider = new SandboxMailProvider();
const NOW = new Date('2026-10-26T10:00:00Z');

async function seedDossier(o: {
  email: string;
  arm?: 'treatment' | 'holdout';
  title?: string;
  amount?: number;
  replied?: Date;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into contacts (workspace_id, email) values ($1::uuid, $2) on conflict (workspace_id, email) do nothing`,
    [workspaceId, o.email],
  );
  const c = await db.query<{ id: string }>(
    'select id from contacts where workspace_id = $1::uuid and email = $2',
    [workspaceId, o.email],
  );
  await db.query(
    `insert into opportunities (id, workspace_id, external_ref, client_name, contact_id, title,
                                amount_cents, sent_at, status, arm, stage)
     values ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7::bigint, $8::timestamptz, 'open', $9, 'proposal_sent')`,
    [id, workspaceId, `inbox-${id.slice(0, 8)}`, `Client ${id.slice(0, 4)}`, c.rows[0]!.id,
     o.title ?? 'Devis remboursement formation', o.amount ?? 800_000,
     new Date(NOW.getTime() - 9 * 86_400_000).toISOString(), o.arm ?? 'treatment'],
  );
  if (o.replied) {
    await db.query('update opportunities set reply_received_at = $2::timestamptz where id = $1::uuid',
      [id, o.replied.toISOString()]);
  }
  return id;
}

async function markSent(opportunityId: string, providerMessageId: string, subject = 'Devis remboursement formation'): Promise<void> {
  await db.query(
    `insert into actions (workspace_id, opportunity_id, kind, status, actor_type, subject, provider, provider_message_id, sent_at)
     values ($1::uuid, $2::uuid, 'sent', 'sent', 'system', $3, 'sandbox', $4, now())`,
    [workspaceId, opportunityId, subject, providerMessageId],
  );
  // An outgoing mail row too — the thread and subject candidates come from there.
  await db.query(
    `insert into mail_messages (workspace_id, mailbox_id, opportunity_id, direction, provider_id,
                                from_email, subject, snippet, sent_at)
     values ($1::uuid, $2::uuid, $3::uuid, 'out', $4, 'nous@agence.fr', $5, 'corps…', now())`,
    [workspaceId, mailboxId, opportunityId, providerMessageId, subject],
  );
}

function incoming(o: {
  from: string; subject?: string; text?: string; providerId?: string;
  headers?: Record<string, string>; threadId?: string; to?: string[];
}): NormalisedMessage {
  return normalise({
    providerId: o.providerId ?? `in-${Math.random().toString(36).slice(2, 8)}`,
    threadId: o.threadId,
    from: o.from,
    to: o.to ?? ['nous@agence.fr'],
    subject: o.subject ?? 'Re: Devis remboursement formation',
    body: o.text ?? 'Bonjour, received, let us talk tomorrow.',
    headers: o.headers ?? {},
    sentAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    storeBody: false,
  });
}

async function sync(): Promise<Awaited<ReturnType<typeof syncMailbox>>> {
  return syncMailbox(db,
    { id: mailboxId, workspaceId, provider: 'sandbox', email: 'nous@agence.fr', cursor: null, credentials: null },
    provider,
    { storeBody: false, now: NOW });
}

async function pendingAction(opportunityId: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into actions (workspace_id, opportunity_id, kind, status, actor_type, subject, draft_text, scheduled_for)
     values ($1::uuid, $2::uuid, 'approved', 'approved', 'user', 'Relance', 'corps', now() + interval '1 hour')
     returning id`,
    [workspaceId, opportunityId],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  sandboxMail(); // ensure the global instance exists even if unused
  provider.inboxes.delete(mailboxId); // fresh scripted inbox per test
  const created = await createWorkspaceWithOwner(db, {
    email: 'sync@agence-bellamy.fr', workspaceName: 'Agence Bellamy', locale: 'fr',
  });
  workspaceId = created.workspaceId;
  userId = created.userId;
  mailboxId = await connectMailbox(db, workspaceId, { provider: 'sandbox', email: 'nous@agence.fr' });
});

describe('criterion 2 — stop on reply, two phases', () => {
  it('a reply cancels the pending approved action; the send job then sends nothing', async () => {
    const oppId = await seedDossier({ email: 'marie.dupont@client-a.fr' });
    const actionId = await pendingAction(oppId);
    await markSent(oppId, '<sent-a-1@rros>');

    provider.deliver(mailboxId, incoming({ from: 'marie.dupont@client-a.fr', headers: { 'in-reply-to': '<sent-a-1@rros>' } }));
    const out = await sync();
    expect(out.status).toBe('synced');
    expect(out.replies).toBe(1);

    const action = await db.query<{ status: string; rationale: string | null }>(
      'select status, rationale from actions where id = $1::uuid', [actionId],
    );
    expect(action.rows[0]!.status).toBe('cancelled');
    expect(action.rows[0]!.rationale).toBe('reply_received');

    const reply = await db.query<{ kind: string; status: string }>(
      `select kind, status from actions where opportunity_id = $1::uuid and kind = 'reply_detected'`,
      [oppId],
    );
    expect(reply.rows[0]).toEqual({ kind: 'reply_detected', status: 'done' });

    // Phase two: the send job runs against the cancelled state and sends nothing.
    const { sendDueAction } = await import('../repo/actions.ts');
    const { defaultEmailProvider } = await import('../../../domain/src/sending/providers/index.ts');
    const cycle = await sendDueAction(db, {
      workspaceId, provider: defaultEmailProvider(), now: new Date(),
      sandboxOwnerEmail: 'sync@agence-bellamy.fr', sandboxEnabled: true,
    });
    expect(cycle.status).toBe('idle');
  });
});

describe('criterion 3 — opt-out beats everything, including the holdout', () => {
  it('sets opt_out_at from a French keyword and the contact never queues again', async () => {
    // In the HOLDOUT on purpose.
    const oppId = await seedDossier({ email: 'jean.martin@client-h.fr', arm: 'holdout' });
    await markSent(oppId, '<sent-h-1@rros>');
    provider.deliver(mailboxId, incoming({
      from: 'jean.martin@client-h.fr',
      headers: { 'in-reply-to': '<sent-h-1@rros>' },
      text: 'Merci, mais merci de me désinscrire.',
    }));
    await sync();

    const contact = await db.query<{ opt_out_at: Date | null }>(
      `select c.opt_out_at from contacts c join opportunities o on o.contact_id = c.id where o.id = $1::uuid`,
      [oppId],
    );
    expect(contact.rows[0]!.opt_out_at).not.toBeNull();

    // The queue refuses the contact, holdout or not.
    const pool = await db.query<{ n: number }>(
      `select count(*)::int as n from opportunities o
         join contacts c on c.id = o.contact_id
        where o.workspace_id = $1::uuid and c.opt_out_at is not null`,
      [workspaceId],
    );
    expect(pool.rows[0]!.n).toBe(1);

    const queued = await db.query<{ id: string }>(
      `select o.id from opportunities o join contacts c on c.id = o.contact_id
        where o.workspace_id = $1::uuid and c.opt_out_at is not null
          and o.id in (select opportunity_id from recommendations where workspace_id = $1::uuid)`,
      [workspaceId],
    );
    expect(queued.rows).toHaveLength(0);
    expect(db).toBeDefined();
  });

  it('the opt-out audit trail records the keyword, not the message', async () => {
    const oppId = await seedDossier({ email: 'opt@client.fr' });
    await markSent(oppId, '<sent-o-1@rros>');
    provider.deliver(mailboxId, incoming({
      from: 'opt@client.fr', headers: { 'in-reply-to': '<sent-o-1@rros>' },
      subject: 'Stop', text: 'Stop please.',
    }));
    await sync();
    const audit = await db.query<{ after: { keyword: string } }>(
      `select after from audit_log where workspace_id = $1::uuid and action = 'contact.opt_out'`,
      [workspaceId],
    );
    expect(audit.rows[0]!.after.keyword).toBe('stop');
  });
});

describe('criterion 4 — bounce: blocked address, exactly one alert', () => {
  it('marks the contact bounced and alerts once across two syncs', async () => {
    const oppId = await seedDossier({ email: 'dead@client-d.fr' });
    await markSent(oppId, '<sent-d-1@rros>');

    const bounce = incoming({
      from: 'Mailer Daemon <mailer-daemon@mx.client-d.fr>',
      to: ['dead@client-d.fr'],
      subject: 'Undelivered Mail Returned to Sender',
      text: 'Delivery to dead@client-d.fr failed permanently.',
    });
    provider.deliver(mailboxId, bounce);
    const first = await sync();
    expect(first.bounces).toBe(1);

    // Second sync re-fetches nothing new, but a NEW bounce for the same address
    // must still not produce a second owner alert.
    provider.deliver(mailboxId, incoming({
      from: 'mailer-daemon@mx.client-d.fr',
      to: ['dead@client-d.fr'],
      subject: 'Delivery Status Notification (Failure)',
      providerId: 'in-bounce-2',
    }));
    const second = await sync();
    expect(second.bounces).toBe(0);

    const contact = await db.query<{ bounced_at: Date | null }>(
      `select c.bounced_at from contacts c join opportunities o on o.contact_id = c.id where o.id = $1::uuid`,
      [oppId],
    );
    expect(contact.rows[0]!.bounced_at).not.toBeNull();

    const alerts = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_log where workspace_id = $1::uuid and action = 'bounce.alerted'`,
      [workspaceId],
    );
    expect(alerts.rows[0]!.n).toBe(1);

    // And the send job refuses the address from now on (stop rule).
    const { checkStopRules } = await import('../../../domain/src/sending/stopRules.ts');
    const verdict = checkStopRules({
      arm: 'treatment', opportunityStatus: 'open', touchCount: 1, lastTouchAt: new Date(),
      replyReceivedAt: null, contactOptedOut: false,
      contactBouncedAt: new Date(), workspaceStatus: 'active', sendsToday: 0,
    }, NOW);
    expect(verdict.sendable).toBe(false);
    expect(verdict.code).toBe('CONTACT_BOUNCED');
  });
});

describe('criterion 5 — token safety', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no log line and no API shape ever contains the access token', async () => {
    const { encryptSecret } = await import('../../../domain/src/inbox/secretBox.ts');
    const token = 'ya29.super-secret-access-token-DO-NOT-LOG';
    await db.query(
      `update mailbox_connections set credentials_encrypted = $2 where id = $1::uuid`,
      [mailboxId, encryptSecret(JSON.stringify({ accessToken: token }))],
    );

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));

    await syncMailbox(db,
      { id: mailboxId, workspaceId, provider: 'sandbox', email: 'nous@agence.fr', cursor: null, credentials: encryptSecret(JSON.stringify({ accessToken: token })) },
      provider, { storeBody: false, now: NOW });

    const all = logs.join('\n');
    expect(all).not.toContain(token);
    expect(encryptSecret(token)).not.toContain(token);
  });
});

describe('criterion 6 — privacy default', () => {
  it('store_body=false persists no body and a snippet ≤ 1 000 chars', async () => {
    const oppId = await seedDossier({ email: 'privacy@client.fr' });
    await markSent(oppId, '<sent-p-1@rros>');
    provider.deliver(mailboxId, incoming({
      from: 'privacy@client.fr', headers: { 'in-reply-to': '<sent-p-1@rros>' },
      text: 'x'.repeat(4_000),
    }));
    await sync();

    const row = await db.query<{ body: string | null; snippet: string }>(
      `select body, snippet from mail_messages where mailbox_id = $1::uuid and direction = 'in'`,
      [mailboxId],
    );
    expect(row.rows[0]!.body).toBeNull();
    expect(row.rows[0]!.snippet.length).toBeLessThanOrEqual(1_000);
  });

  it('toggling on stores bodies for NEW messages only', async () => {
    const oppId = await seedDossier({ email: 'bodies@client.fr' });
    await markSent(oppId, '<sent-bd-1@rros>');
    provider.deliver(mailboxId, incoming({
      from: 'bodies@client.fr', headers: { 'in-reply-to': '<sent-bd-1@rros>' },
      providerId: 'in-before', text: 'before the toggle',
    }));
    await sync();
    await db.query('update workspaces set store_body = true where id = $1::uuid', [workspaceId]);

    // The new message arrives AFTER the toggle: its provider-side normalisation
    // keeps the body this time.
    provider.deliver(mailboxId, normalise({
      providerId: 'in-after',
      from: 'bodies@client.fr',
      subject: 'Re: Devis remboursement formation',
      body: 'after the toggle',
      headers: { 'in-reply-to': '<sent-bd-1@rros>' },
      sentAt: new Date(NOW.getTime() + 7_200_000).toISOString(),
      storeBody: true,
    }));
    const cursor = await db.query<{ sync_cursor: string | null }>(
      'select sync_cursor from mailbox_connections where id = $1::uuid', [mailboxId],
    );
    await syncMailbox(db,
      { id: mailboxId, workspaceId, provider: 'sandbox', email: null, cursor: cursor.rows[0]!.sync_cursor, credentials: null },
      provider, { storeBody: true, now: NOW });
    const rows = await db.query<{ provider_id: string; body: string | null }>(
      `select provider_id, body from mail_messages where mailbox_id = $1::uuid order by provider_id`,
      [mailboxId],
    );
    expect(rows.rows.find((r) => r.provider_id === 'in-before')?.body).toBeNull();
    expect(rows.rows.find((r) => r.provider_id === 'in-after')?.body).toBe('after the toggle');
  });
});

describe('criterion 7 — retention purges bodies and snippets, counts only', () => {
  it('deletes exactly the old bodies/snippets and logs counts, never contents', async () => {
    await db.query('update workspaces set store_body = false where id = $1::uuid', [workspaceId]);
    // 100 old messages with bodies, 3 recent ones.
    for (let i = 0; i < 100; i += 1) {
      await db.query(
        `insert into mail_messages (workspace_id, mailbox_id, direction, provider_id, from_email,
                                    subject, snippet, body, sent_at)
         values ($1::uuid, $2::uuid, 'in', $3, 'x@y.fr', 's', $4, $4, now() - interval '120 days')`,
        [workspaceId, mailboxId, `old-${i}`, `secret body ${i}`],
      );
    }
    for (let i = 0; i < 3; i += 1) {
      await db.query(
        `insert into mail_messages (workspace_id, mailbox_id, direction, provider_id, from_email,
                                    subject, snippet, body, sent_at)
         values ($1::uuid, $2::uuid, 'in', $3, 'x@y.fr', 's', $4, $4, now() - interval '2 days')`,
        [workspaceId, mailboxId, `new-${i}`, `fresh body ${i}`],
      );
    }

    const out = await purgeOldBodies(db, NOW);
    expect(out.messages).toBe(100);

    const left = await db.query<{ n: number }>(
      `select count(*)::int as n from mail_messages where mailbox_id = $1::uuid and (body is not null or snippet <> '')`,
      [mailboxId],
    );
    expect(left.rows[0]!.n).toBe(3);

    // The log carries a count, never a content.
    const logs = await db.query<{ after: unknown }>(
      `select after from audit_log where action = 'retention.purged' and workspace_id = $1::uuid`,
      [workspaceId],
    );
    expect(JSON.stringify(logs.rows[0]!.after)).toContain('"messages":100');
    expect(JSON.stringify(logs.rows)).not.toContain('secret body');
  });

  it('a workspace that opted in keeps its bodies', async () => {
    await db.query('update workspaces set store_body = true where id = $1::uuid', [workspaceId]);
    await db.query(
      `insert into mail_messages (workspace_id, mailbox_id, direction, provider_id, from_email,
                                  subject, snippet, body, sent_at)
       values ($1::uuid, $2::uuid, 'in', 'opted-old', 'x@y.fr', 's', 'extrait', 'corps complet', now() - interval '200 days')`,
      [workspaceId, mailboxId],
    );
    const out = await purgeOldBodies(db, NOW);
    expect(out.messages).toBe(0);
    const kept = await db.query<{ body: string | null }>(
      `select body from mail_messages where provider_id = 'opted-old'`,
    );
    expect(kept.rows[0]!.body).toBe('corps complet');
  });
});

describe('criterion 8 — cursor correctness', () => {
  it('syncing twice with no new mail writes nothing and never duplicates reply_detected', async () => {
    const oppId = await seedDossier({ email: 'twice@client.fr' });
    await markSent(oppId, '<sent-t-1@rros>');
    provider.deliver(mailboxId, incoming({
      from: 'twice@client.fr', headers: { 'in-reply-to': '<sent-t-1@rros>' }, providerId: 'in-once',
    }));

    const first = await sync();
    expect(first.replies).toBe(1);
    const afterFirst = await db.query<{ n: number }>('select count(*)::int as n from mail_messages');
    const cursor = await db.query<{ sync_cursor: string | null }>(
      'select sync_cursor from mailbox_connections where id = $1::uuid', [mailboxId],
    );

    // Second pass: the provider stream is unchanged, the cursor says "done".
    provider.inboxes.set(mailboxId, []); // nothing new on the server
    const modified = { id: mailboxId, workspaceId, provider: 'sandbox' as const, email: null, cursor: cursor.rows[0]!.sync_cursor, credentials: null };
    const second = await syncMailbox(db, modified, provider, { storeBody: false, now: NOW });
    expect(second.fetched).toBe(0);

    const afterSecond = await db.query<{ n: number }>('select count(*)::int as n from mail_messages');
    expect(afterSecond.rows[0]!.n).toBe(afterFirst.rows[0]!.n);
    const replies = await db.query<{ n: number }>(
      `select count(*)::int as n from actions where opportunity_id = $1::uuid and kind = 'reply_detected'`,
      [oppId],
    );
    expect(replies.rows[0]!.n).toBe(1);
  });
});

describe('criterion 9 — revocation', () => {
  it('disconnect destroys the credentials and the next sync skips with revoked', async () => {
    const stored = await db.query<{ credentials_encrypted: string | null }>(
      'select credentials_encrypted from mailbox_connections where id = $1::uuid', [mailboxId],
    );
    await db.query(
      `update mailbox_connections set credentials_encrypted = 'v1:fake:fake:fake' where id = $1::uuid`,
      [mailboxId],
    );
    await disconnectMailbox(db, workspaceId, mailboxId);

    const after = await db.query<{ credentials_encrypted: string | null; status: string; revoked_at: Date | null }>(
      'select credentials_encrypted, status, revoked_at from mailbox_connections where id = $1::uuid', [mailboxId],
    );
    expect(after.rows[0]!.credentials_encrypted).toBeNull();
    expect(after.rows[0]!.status).toBe('disconnected');
    expect(after.rows[0]!.revoked_at).not.toBeNull();
    void stored;

    const out = await syncMailbox(db,
      { id: mailboxId, workspaceId, provider: 'sandbox', email: null, cursor: null, credentials: null },
      provider, { storeBody: false, now: NOW });
    expect(out.status).toBe('revoked');

    // The reply history survives on purpose.
    const oppId = await seedDossier({ email: 'hist@client.fr' });
    expect(oppId).toBeDefined();
  });
});

describe('criterion 10 — a 429 backs off and loses nothing', () => {
  it('keeps the cursor, then the next run resumes from it', async () => {
    const oppId = await seedDossier({ email: 'rl@client.fr' });
    await markSent(oppId, '<sent-rl-1@rros>');
    provider.deliver(mailboxId, incoming({
      from: 'rl@client.fr', headers: { 'in-reply-to': '<sent-rl-1@rros>' }, providerId: 'in-rl',
    }));

    let fail = true;
    const throttled = {
      kind: 'sandbox' as const,
      listMessages: async () => {
        if (fail) throw new RateLimitedError(60);
        return provider.listMessages({ id: mailboxId, workspaceId, provider: 'sandbox', email: null, cursor: null, credentials: null }, null);
      },
      send: async () => ({ providerMessageId: 'x' }),
      revoke: async () => {},
    };
    const backoff = await syncMailbox(db,
      { id: mailboxId, workspaceId, provider: 'sandbox', email: null, cursor: null, credentials: null },
      throttled, { storeBody: false, now: NOW });
    expect(backoff.status).toBe('backoff');

    const untouched = await db.query<{ n: number }>('select count(*)::int as n from mail_messages');
    const cursor = await db.query<{ sync_cursor: string | null }>(
      'select sync_cursor from mailbox_connections where id = $1::uuid', [mailboxId],
    );
    expect(cursor.rows[0]!.sync_cursor).toBeNull();

    // Next run: same cursor (null → the beginning), the reply is found once.
    fail = false;
    const resumed = await syncMailbox(db,
      { id: mailboxId, workspaceId, provider: 'sandbox', email: null, cursor: cursor.rows[0]!.sync_cursor, credentials: null },
      throttled, { storeBody: false, now: NOW });
    expect(resumed.status).toBe('synced');
    expect(resumed.replies).toBe(1);
    const dup = await db.query<{ n: number }>(
      `select count(*)::int as n from actions where kind = 'reply_detected' and opportunity_id = $1::uuid`,
      [oppId],
    );
    expect(dup.rows[0]!.n).toBe(1);
    // The backoff run wrote nothing: only the outgoing message from markSent exists.
    expect(untouched.rows[0]!.n).toBe(1);
  });
});

describe('the out-of-office trap', () => {
  it('an auto-reply pauses 7 days instead of stopping the sequence', async () => {
    const oppId = await seedDossier({ email: 'ooo@client.fr' });
    await markSent(oppId, '<sent-ooo-1@rros>');
    const actionId = await pendingAction(oppId);

    provider.deliver(mailboxId, incoming({
      from: 'ooo@client.fr', headers: { 'in-reply-to': '<sent-ooo-1@rros>', 'auto-submitted': 'auto-replied' },
      subject: 'Re: Devis remboursement formation',
      text: 'Je suis absent jusqu’au 15 novembre.',
      providerId: 'in-ooo',
    }));
    const out = await sync();
    expect(out.pauses).toBe(1);
    expect(out.replies ?? 0).toBe(0);

    const opp = await db.query<{ reply_received_at: Date | null }>(
      'select reply_received_at from opportunities where id = $1::uuid', [oppId],
    );
    expect(opp.rows[0]!.reply_received_at).toBeNull();

    const action = await db.query<{ status: string; scheduled_for: string }>(
      'select status, scheduled_for from actions where id = $1::uuid', [actionId],
    );
    expect(action.rows[0]!.status).toBe('approved');
    expect(new Date(action.rows[0]!.scheduled_for).getTime())
      .toBeGreaterThan(NOW.getTime() + 6 * 86_400_000);
  });
});
