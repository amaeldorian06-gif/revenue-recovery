import type { Db } from '../client.ts';
import { enqueueWebhook } from './team.ts';
import {
  matchReply, type MailCandidate,
} from '../../../domain/src/inbox/match.ts';
import {
  normalizeSubject, detectOptOut, isAutoReply, SNIPPET_MAX,
} from '../../../domain/src/inbox/normalize.ts';
import { encryptSecret, decryptSecret } from '../../../domain/src/inbox/secretBox.ts';
import type { NormalisedMessage, Mailbox, MailProvider } from '../../../domain/src/inbox/provider.ts';

/**
 * The sync engine. One mailbox per cron invocation (round-robin), a 30-second
 * deadline, a cursor written only after processing: a slow mailbox never
 * blocks the others, and an interrupted run resumes instead of duplicating.
 */

export interface SyncOutcome {
  status: 'synced' | 'revoked' | 'backoff' | 'error' | 'deadline';
  mailboxId: string;
  fetched?: number;
  replies?: number;
  bounces?: number;
  optOuts?: number;
  pauses?: number;
}

// ---------------------------------------------------------------- candidates

async function loadCandidates(db: Db, workspaceId: string): Promise<MailCandidate[]> {
  // Open dossiers only: a closed dossier cannot "receive a reply" anymore.
  const rows = await db.query<{
    id: string; email: string; subject_hint: string | null; client_name: string;
  }>(
    `select o.id, c.email, o.title as subject_hint, o.client_name
       from opportunities o
       join contacts c on c.id = o.contact_id
      where o.workspace_id = $1::uuid
        and o.reply_received_at is null
        and o.status in ('open','dormant')
        and c.opt_out_at is null`,
    [workspaceId],
  );
  if (rows.rows.length === 0) return [];

  const ids = rows.rows.map((r) => r.id);
  const sent = await db.query<{ opportunity_id: string; provider_message_id: string }>(
    `select opportunity_id, provider_message_id from actions
      where workspace_id = $1::uuid and kind = 'sent'
        and provider_message_id is not null
        and opportunity_id = any($2::uuid[])`,
    [workspaceId, ids],
  );
  const outMsgs = await db.query<{ opportunity_id: string | null; provider_id: string; thread_id: string | null }>(
    `select opportunity_id, provider_id, thread_id from mail_messages
      where workspace_id = $1::uuid and direction = 'out' and opportunity_id = any($2::uuid[])`,
    [workspaceId, ids],
  );

  const byOpp = new Map<string, MailCandidate>();
  for (const r of rows.rows) {
    byOpp.set(r.id, {
      opportunityId: r.id,
      contactEmail: (r.email ?? '').toLowerCase(),
      sentProviderIds: [],
      threadIds: [],
      normalizedSubject: normalizeSubject(r.subject_hint ?? r.client_name),
    });
  }
  for (const s of sent.rows) {
    byOpp.get(s.opportunity_id)?.sentProviderIds.push(s.provider_message_id);
  }
  for (const m of outMsgs.rows) {
    const c = m.opportunity_id ? byOpp.get(m.opportunity_id) : undefined;
    if (!c) continue;
    c.sentProviderIds.push(m.provider_id);
    if (m.thread_id) c.threadIds.push(m.thread_id);
  }
  return [...byOpp.values()];
}

// ------------------------------------------------------------- persistence

async function messageAlreadySeen(db: Db, mailboxId: string, providerId: string): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    'select id from mail_messages where mailbox_id = $1::uuid and provider_id = $2',
    [mailboxId, providerId],
  );
  return r.rows.length > 0;
}

interface StoreArgs {
  db: Db;
  workspaceId: string;
  mailboxId: string;
  message: NormalisedMessage;
  opportunityId: string | null;
  direction: 'in' | 'out';
}

async function storeMessage({ db, workspaceId, mailboxId, message, opportunityId, direction }: StoreArgs): Promise<void> {
  await db.query(
    `insert into mail_messages
       (workspace_id, mailbox_id, opportunity_id, direction, provider_id, thread_id,
        from_email, to_emails, cc_emails, subject, snippet, body, headers, sent_at, is_bounce)
     values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
             $11, $12, $13::jsonb, $14::timestamptz, $15)
     on conflict (mailbox_id, provider_id) do nothing`,
    [
      workspaceId, mailboxId, opportunityId, direction, message.providerId, message.threadId ?? null,
      message.from, JSON.stringify(message.to), JSON.stringify(message.cc), message.subject,
      message.snippet.slice(0, SNIPPET_MAX), message.body ?? null,
      JSON.stringify(message.headers), message.sentAt, message.isBounce,
    ],
  );
}

// ------------------------------------------------------------ reply handling

async function processReply(
  db: Db, workspaceId: string, opportunityId: string, message: NormalisedMessage, now: Date,
): Promise<{ reply: boolean; optOut: string | null }> {
  // The contact email of the dossier decides where opt-out lands.
  const opp = await db.query<{ contact_id: string; email: string; reply_received_at: Date | null }>(
    `select o.contact_id, c.email, o.reply_received_at
       from opportunities o join contacts c on c.id = o.contact_id
      where o.id = $1::uuid`,
    [opportunityId],
  );
  const row = opp.rows[0];
  if (!row) return { reply: false, optOut: null };

  // Opt-out beats everything, including the holdout (ethics over measurement).
  const optOut = detectOptOut(message.subject, message.snippet, message.body);
  if (optOut) {
    await db.query(
      'update contacts set opt_out_at = coalesce(opt_out_at, $2::timestamptz) where id = $1::uuid',
      [row.contact_id, now.toISOString()],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'contact.opt_out', 'contact', $2, $3::jsonb)`,
      [workspaceId, row.contact_id, JSON.stringify({ keyword: optOut, providerId: message.providerId })],
    );
  }

  let recorded = false;
  if (row.reply_received_at === null) {
    await db.query(
      'update opportunities set reply_received_at = $2::timestamptz, updated_at = now() where id = $1::uuid',
      [opportunityId, message.sentAt],
    );
    // Cancel every pending action of that dossier — the sequence stops now.
    const cancelled = await db.query<{ id: string }>(
      `update actions set status = 'cancelled', rationale = 'reply_received', updated_at = now()
       where opportunity_id = $1::uuid and workspace_id = $2::uuid
         and status in ('draft','approved','sending','deferred')
       returning id`,
      [opportunityId, workspaceId],
    );
    // The trace: an action-shaped event, and the scoring signal.
    await db.query(
      `insert into actions
         (workspace_id, opportunity_id, kind, status, actor_type, rationale, provider_message_id)
       values ($1::uuid, $2::uuid, 'reply_detected', 'done', 'system', $3, $4)`,
      [workspaceId, opportunityId, `via ${message.from}`, message.providerId],
    );
    await db.query(
      `insert into signal_events (workspace_id, opportunity_id, kind, occurred_at, source)
       values ($1::uuid, $2::uuid, 'reply', $3::timestamptz, 'inbox_sync')`,
      [workspaceId, opportunityId, message.sentAt],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'reply.detected', 'opportunity', $2, $3::jsonb)`,
      [workspaceId, opportunityId, JSON.stringify({
        providerId: message.providerId, cancelledActions: cancelled.rows.length,
      })],
    );
    await enqueueWebhook(db, workspaceId, 'reply.received', {
      id: crypto.randomUUID(), event: 'reply.received',
      opportunityId, cancelledActions: cancelled.rows.length,
    });
    recorded = true;
  }
  return { reply: recorded, optOut };
}

/** An out-of-office pauses 7 days instead of stopping the sequence. */
async function pauseSequence(db: Db, workspaceId: string, opportunityId: string, now: Date): Promise<void> {
  await db.query(
    `update actions set scheduled_for = $3::timestamptz + interval '7 days', updated_at = now()
      where opportunity_id = $1::uuid and workspace_id = $2::uuid
        and status in ('approved','deferred') and scheduled_for is not null`,
    [opportunityId, workspaceId, now.toISOString()],
  );
}

async function processBounce(
  db: Db, workspaceId: string, opportunityId: string, message: NormalisedMessage, now: Date,
): Promise<boolean> {
  await db.query(
    `update contacts set bounced_at = coalesce(bounced_at, $2::timestamptz)
      where id = (select contact_id from opportunities where id = $1::uuid)`,
    [opportunityId, now.toISOString()],
  );
  // Prompt-literal: the address bounced — the sent actions carry the reason,
  // and stopRules CONTACT_BOUNCED blocks any further send.
  await db.query(
    `update actions set error_code = 'bounce'
      where opportunity_id = $1::uuid and workspace_id = $2::uuid
        and kind = 'sent' and error_code is null`,
    [opportunityId, workspaceId],
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
     values ($1::uuid, 'system', 'reply.bounce', 'opportunity', $2, $3::jsonb)`,
    [workspaceId, opportunityId, JSON.stringify({ from: message.from, providerId: message.providerId })],
  );
  // The owner is alerted exactly once per address, not once per sync.
  const prior = await db.query<{ n: number }>(
    `select count(*)::int as n from audit_log
      where workspace_id = $1::uuid and action = 'bounce.alerted'
        and entity_id = $2::text`,
    [workspaceId, opportunityId],
  );
  if ((prior.rows[0]?.n ?? 0) === 0) {
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'bounce.alerted', 'opportunity', $2::text, $3::jsonb)`,
      [workspaceId, opportunityId, JSON.stringify({ at: now.toISOString() })],
    );
    return true;
  }
  return false;
}

// ----------------------------------------------------------------- the sync

export async function syncMailbox(
  db: Db,
  mailbox: Mailbox,
  provider: MailProvider,
  opts: { storeBody: boolean; now?: Date; deadlineMs?: number },
): Promise<SyncOutcome> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.deadlineMs ?? 30_000);

  if (mailbox.provider === 'sandbox' ? false : mailbox.credentials === null) {
    return { status: 'revoked', mailboxId: mailbox.id };
  }
  const state = await db.query<{ status: string; revoked_at: Date | null }>(
    'select status, revoked_at from mailbox_connections where id = $1::uuid',
    [mailbox.id],
  );
  const st = state.rows[0];
  if (!st || st.status === 'disconnected' || st.revoked_at !== null) {
    return { status: 'revoked', mailboxId: mailbox.id };
  }

  const storeBody = opts.storeBody === true;
  let messages: NormalisedMessage[];
  let nextCursor: string;
  try {
    // The privacy choice travels with the mailbox: providers must not fetch
    // bodies the workspace never asked to store.
    const page = await provider.listMessages({ ...mailbox, storeBody }, mailbox.cursor);
    messages = page.messages;
    nextCursor = page.nextCursor;
  } catch (err) {
    const code = (err as { name?: string }).name;
    if (code === 'RateLimitedError') {
      await db.query(
        'update mailbox_connections set last_error = $2, last_error_at = now() where id = $1::uuid',
        [mailbox.id, 'rate_limited'],
      );
      // Cursor untouched: the next run resumes exactly where this one stopped.
      return { status: 'backoff', mailboxId: mailbox.id };
    }
    await db.query(
      'update mailbox_connections set last_error = $2, last_error_at = now() where id = $1::uuid',
      [mailbox.id, (err as Error).message.slice(0, 200)],
    );
    return { status: 'error', mailboxId: mailbox.id };
  }

  const candidates = await loadCandidates(db, workspaceIdOf(mailbox));
  let replies = 0;
  let bounces = 0;
  let optOuts = 0;
  let pauses = 0;

  for (const message of messages) {
    if (Date.now() > deadline) {
      // Resumability beats completeness: stop, keep the cursor unadvanced so
      // the unseen messages come back next run.
      await db.query(
        'update mailbox_connections set last_sync_at = now() where id = $1::uuid',
        [mailbox.id],
      );
      return { status: 'deadline', mailboxId: mailbox.id, fetched: countSeen(messages, message.providerId), replies, bounces, optOuts, pauses };
    }

    // Dedupe by provider id: a refetch must never write twice (criterion 8).
    if (await messageAlreadySeen(db, mailbox.id, message.providerId)) continue;

    if (message.isBounce) {
      const candidate = candidates.find((c) => c.contactEmail === emailOf(message.from))
        ?? null;
      const oppId = candidate?.opportunityId ?? await opportunityByRecentSend(db, workspaceIdOf(mailbox), message);
      await storeMessage({ db, workspaceId: workspaceIdOf(mailbox), mailboxId: mailbox.id, message, opportunityId: oppId, direction: 'in' });
      if (oppId) {
        const alerted = await processBounce(db, workspaceIdOf(mailbox), oppId, message, now);
        bounces += alerted ? 1 : 0;
      }
      continue;
    }

    // Machine mail: pause 7 days, never record a human reply.
    if (isAutoReply(message.headers as unknown as Record<string, string>)) {
      const match = matchReply(message, candidates);
      await storeMessage({ db, workspaceId: workspaceIdOf(mailbox), mailboxId: mailbox.id, message, opportunityId: match?.opportunityId ?? null, direction: 'in' });
      if (match) {
        await pauseSequence(db, workspaceIdOf(mailbox), match.opportunityId, now);
        pauses += 1;
      }
      continue;
    }

    const match = matchReply(message, candidates);
    await storeMessage({ db, workspaceId: workspaceIdOf(mailbox), mailboxId: mailbox.id, message, opportunityId: match?.opportunityId ?? null, direction: 'in' });
    if (match) {
      const res = await processReply(db, workspaceIdOf(mailbox), match.opportunityId, message, now);
      if (res.reply) replies += 1;
      if (res.optOut) optOuts += 1;
    }
  }

  // The cursor advances only after everything processed above succeeded.
  await db.query(
    `update mailbox_connections set sync_cursor = $2, last_sync_at = now(),
       last_error = null, last_error_at = null
      where id = $1::uuid`,
    [mailbox.id, nextCursor],
  );
  return { status: 'synced', mailboxId: mailbox.id, fetched: messages.length, replies, bounces, optOuts, pauses };
}

function workspaceIdOf(mailbox: Mailbox): string {
  return mailbox.workspaceId;
}

function emailOf(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim().toLowerCase();
}

function countSeen(messages: NormalisedMessage[], untilProviderId: string): number {
  const idx = messages.findIndex((m) => m.providerId === untilProviderId);
  return idx === -1 ? messages.length : idx + 1;
}

async function opportunityByRecentSend(db: Db, workspaceId: string, message: NormalisedMessage): Promise<string | null> {
  // A bounce comes FROM the mailer-daemon: the dossier is the one whose
  // contact email is the Return-Path recipient (ours: the first local part).
  const target = message.to[0]?.toLowerCase() ?? '';
  const r = await db.query<{ id: string }>(
    `select o.id from opportunities o
       join contacts c on c.id = o.contact_id
      where o.workspace_id = $1::uuid and lower(c.email) = $2
      order by o.updated_at desc limit 1`,
    [workspaceId, target],
  );
  return r.rows[0]?.id ?? null;
}

// --------------------------------------------------------------- mailbox CRUD

export async function connectMailbox(
  db: Db,
  workspaceId: string,
  input: { provider: 'gmail_oauth' | 'smtp_imap' | 'sandbox'; email: string; credentials?: unknown },
): Promise<string> {
  const payload = input.credentials ? encryptSecret(JSON.stringify(input.credentials)) : null;
  const r = await db.query<{ id: string }>(
    `insert into mailbox_connections (workspace_id, provider, status, email_address, credentials_encrypted)
     values ($1::uuid, $2, 'connected', $3, $4)
     on conflict (workspace_id, provider) do update
       set status = 'connected', email_address = excluded.email_address,
           credentials_encrypted = excluded.credentials_encrypted,
           revoked_at = null, sync_cursor = null
     returning id`,
    [workspaceId, input.provider, input.email, payload],
  );
  return r.rows[0]!.id;
}

/** One click: tokens destroyed immediately, reply history kept. */
export async function disconnectMailbox(db: Db, workspaceId: string, mailboxId: string): Promise<void> {
  await db.query(
    `update mailbox_connections
        set credentials_encrypted = null, sync_cursor = null,
            status = 'disconnected', revoked_at = now()
      where id = $1::uuid and workspace_id = $2::uuid`,
    [mailboxId, workspaceId],
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
     values ($1::uuid, 'system', 'mailbox.disconnected', 'mailbox', $2, $3::jsonb)`,
    [workspaceId, mailboxId, JSON.stringify({ tokens: 'deleted' })],
  );
}

export async function loadMailboxForSync(db: Db, opts?: { workspaceId?: string }): Promise<{
  id: string; workspaceId: string; provider: Mailbox['provider'];
  email: string | null; cursor: string | null; credentials: string | null;
} | null> {
  // Round-robin: the mailbox least recently synced goes first, so a slow one
  // never starves the others. An explicit workspaceId (ops re-run of one
  // tenant, dev flows) narrows the pick to that workspace's mailboxes.
  const r = await db.query<{
    id: string; workspace_id: string; provider: Mailbox['provider'];
    email_address: string | null; sync_cursor: string | null; credentials_encrypted: string | null;
  }>(
    opts?.workspaceId
      ? `select id, workspace_id, provider, email_address, sync_cursor, credentials_encrypted
           from mailbox_connections
          where status = 'connected' and revoked_at is null and workspace_id = $1::uuid
          order by last_sync_at asc nulls first
          limit 1`
      : `select id, workspace_id, provider, email_address, sync_cursor, credentials_encrypted
           from mailbox_connections
          where status = 'connected' and revoked_at is null
          order by last_sync_at asc nulls first
          limit 1`,
    opts?.workspaceId ? [opts.workspaceId] : undefined,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    email: row.email_address,
    cursor: row.sync_cursor,
    credentials: row.credentials_encrypted,
  };
}

// ------------------------------------------------------------------ retention

export interface PurgeResult {
  workspaces: number;
  messages: number;
}

/**
 * Nightly retention: bodies and snippets older than 90 days disappear from
 * workspaces that did not opt in to body storage. Deletions are logged with
 * counts, never contents.
 */
export async function purgeOldBodies(db: Db, now: Date = new Date(), olderThanDays = 90): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const targets = await db.query<{ workspace_id: string; n: number }>(
    `select m.workspace_id, count(*)::int as n
       from mail_messages m
       join workspaces w on w.id = m.workspace_id
      where w.store_body = false
        and m.sent_at < $1::timestamptz
        and (m.body is not null or m.snippet <> '')
      group by m.workspace_id`,
    [cutoff.toISOString()],
  );
  let total = 0;
  for (const t of targets.rows) {
    const res = await db.query<{ n: number }>(
      `with cleared as (
         update mail_messages set body = null, snippet = ''
          where workspace_id = $1::uuid and sent_at < $2::timestamptz
            and (body is not null or snippet <> '')
          returning 1
       ) select count(*)::int as n from cleared`,
      [t.workspace_id, cutoff.toISOString()],
    );
    const n: number = res.rows[0]?.n ?? 0;
    total += n;
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'retention.purged', 'workspace', $1::text, $2::jsonb)`,
      [t.workspace_id, JSON.stringify({ messages: n, olderThanDays, at: now.toISOString() })],
    );
  }
  return { workspaces: targets.rows.length, messages: total };
}

export { decryptSecret };
