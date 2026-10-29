import { randomUUID } from 'node:crypto';
import type { Db } from '../client.ts';
import { executeSend } from '../../../domain/src/sending/send.ts';
import type { EmailProvider } from '../../../domain/src/sending/providers/types.ts';
import type { SendState, StopCode } from '../../../domain/src/sending/stopRules.ts';
import { editRatio } from '../../../domain/src/drafting/editRatio.ts';

/**
 * Persistence of the outbox. The invariants that matter live here because this is
 * the only code that can write `actions`:
 *   • a draft with no approval never reaches the provider (criterion 5);
 *   • one approval per draft, enforced by a partial unique index;
 *   • every attempt is recorded with `(action_id, attempt)` unique, so a retried
 *     job cannot send twice (criterion 7);
 *   • a sent row writes the final text to the audit log, never the draft
 *     (criterion 10).
 */

export interface ActionRow {
  id: string;
  workspace_id: string;
  opportunity_id: string;
  parent_action_id: string | null;
  kind: string;
  status: string;
  subject: string | null;
  draft_text: string | null;
  final_text: string | null;
  edit_ratio: string | null;
  scheduled_for: string | null;
  sent_at: string | null;
  sandbox: boolean;
  provider_message_id: string | null;
  tone: string | null;
  model: string | null;
  prompt_version: string;
}

export interface OpportunitySnapshot {
  arm: 'treatment' | 'holdout';
  status: string;
  touch_count: number;
  last_touch_at: string | null;
  reply_received_at: string | null;
  email: string | null;
  opt_out_at: string | null;
  bounced_at: string | null;
  client_name: string;
  amount_cents: string;
  sent_at: string;
  title: string | null;
  context_note: string | null;
  stage: string;
  contact_locale: string | null;
  contact_first_name: string | null;
}

const DAY = 86_400_000;

export async function loadOpportunity(db: Db, opportunityId: string): Promise<OpportunitySnapshot | null> {
  const res = await db.query<OpportunitySnapshot & { full_name: string | null }>(
    `select o.arm, o.status, o.touch_count, o.last_touch_at, o.reply_received_at,
            c.email, c.opt_out_at, c.bounced_at, c.full_name, c.locale as contact_locale,
            o.client_name, o.amount_cents, o.sent_at, o.title, o.context_note, o.stage
       from opportunities o
       left join contacts c on c.id = o.contact_id
      where o.id = $1::uuid`,
    [opportunityId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    ...row,
    contact_first_name: firstName(row.full_name, row.email),
  };
}

/** Shared inboxes and generated ids are not people. Greeting a robot by name is worse than "Bonjour". */
const GENERIC_INBOX = new Set([
  'contact', 'info', 'hello', 'bonjour', 'sales', 'admin', 'team', 'support',
  'noreply', 'no-reply', 'office', 'commercial', 'accueil',
]);

function looksHuman(value: string): boolean {
  const v = value.trim();
  if (v === '' || /\d/.test(v)) return false;
  return v.length <= 30;
}

export function firstName(fullName: string | null, email: string | null): string | null {
  const full = (fullName ?? '').trim();
  if (full !== '' && looksHuman(full.split(/\s+/)[0]!)) return full.split(/\s+/)[0]!;

  if (email && email.includes('@')) {
    const cleaned = email.split('@')[0]!.replace(/[._-].*$/, '');
    const lower = cleaned.toLowerCase();
    if (lower === '' || GENERIC_INBOX.has(lower) || !looksHuman(cleaned)) return null;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return null;
}

/** The two messages we already sent to this dossier, oldest first. */
export async function previousMessages(db: Db, opportunityId: string): Promise<string[]> {
  const res = await db.query<{ body: string }>(
    `select coalesce(final_text, draft_text) as body
       from actions
      where opportunity_id = $1::uuid and kind in ('sent','approved') and coalesce(final_text, draft_text) is not null
      order by created_at desc
      limit 2`,
    [opportunityId],
  );
  return res.rows.map((r) => r.body).reverse();
}

export interface DraftRecord {
  opportunityId: string;
  workspaceId: string;
  recommendationId?: string | null;
  tone: string;
  subject: string;
  body: string;
  rationale?: string | null;
  model: string;
  promptVersion: string;
}

/** Store the draft the model proposed. Replaces any live draft for that dossier. */
export async function saveDraft(db: Db, d: DraftRecord): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into actions
       (id, workspace_id, opportunity_id, recommendation_id, kind, status, actor_type,
        tone, subject, draft_text, rationale, model, prompt_version)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'draft_generated', 'draft', 'system',
             $5, $6, $7, $8, $9, $10)
     on conflict (opportunity_id) where kind = 'draft_generated' and status = 'draft' do update
       set subject = excluded.subject,
           draft_text = excluded.draft_text,
           rationale = excluded.rationale,
           model = excluded.model,
           prompt_version = excluded.prompt_version,
           tone = excluded.tone,
           updated_at = now()
     returning id`,
    [
      id, d.workspaceId, d.opportunityId, d.recommendationId ?? null,
      d.tone, d.subject, d.body, d.rationale ?? null, d.model, d.promptVersion,
    ],
  );
  const found = await db.query<{ id: string }>(
    `select id from actions where opportunity_id = $1::uuid and kind = 'draft_generated' and status = 'draft'`,
    [d.opportunityId],
  );
  return found.rows[0]?.id ?? id;
}

/**
 * The manual path. When generation refuses twice, the product degrades to a
 * checklist — never to a dead end. The skeleton is stored as a normal draft row so
 * approval, edit ratio and auditing stay on one code path; its model name says
 * where it came from.
 */
export async function saveManualDraft(
  db: Db,
  input: {
    workspaceId: string;
    opportunityId: string;
    subject: string;
    body: string;
  },
): Promise<string> {
  return saveDraft(db, {
    opportunityId: input.opportunityId,
    workspaceId: input.workspaceId,
    tone: 'warm',
    subject: input.subject,
    body: input.body,
    model: 'manual-skeleton',
    promptVersion: 'manual',
  });
}

/**
 * A generation that failed twice. Persisted so that "we could not write this
 * one" is a product fact with reasons, not a silent hole in the screen.
 */
export async function saveGenerationFailure(
  db: Db,
  input: {
    workspaceId: string;
    opportunityId: string;
    codes: string[];
    model: string;
    promptVersion: string;
    reason: string;
  },
): Promise<void> {
  await db.query(
    // `kind` stays `draft_generated`: the draft was attempted, it was refused.
    // `status = 'failed'` keeps it out of the live-draft partial index.
    `insert into actions
       (workspace_id, opportunity_id, kind, status, actor_type, violation_codes, model, prompt_version, rationale)
     values ($1::uuid, $2::uuid, 'draft_generated', 'failed', 'system', $3::text[], $4, $5, $6)`,
    [input.workspaceId, input.opportunityId, input.codes, input.model, input.promptVersion, input.reason],
  );
}

export interface ApproveResult {
  approvedActionId: string;
  editRatio: number;
  scheduledFor: string;
}

/**
 * Approve a draft: creates the `approved` row (what will be sent) and consumes the
 * draft row. The draft text stays untouched — it is the reference for edit_ratio.
 */
export async function approveDraft(
  db: Db,
  input: {
    draftActionId: string;
    workspaceId: string;
    userId: string;
    finalText: string;
    subject?: string | null;
    scheduledFor?: Date | null;
    now: Date;
  },
): Promise<ApproveResult | null> {
  const draft = await db.query<ActionRow>(
    `select * from actions where id = $1::uuid and workspace_id = $2::uuid and kind = 'draft_generated'`,
    [input.draftActionId, input.workspaceId],
  );
  const row = draft.rows[0];
  if (!row) return null;

  const finalText = input.finalText.trim() === '' ? (row.draft_text ?? '') : input.finalText;
  const ratio = editRatio(row.draft_text ?? '', finalText);
  const scheduledFor = input.scheduledFor ?? input.now;
  const approvedId = randomUUID();

  await db.query(
    `insert into actions
       (id, workspace_id, opportunity_id, parent_action_id, kind, status, actor_type, actor_user_id,
        tone, subject, final_text, edit_ratio, model, prompt_version, scheduled_for)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'approved', 'approved', 'user', $5::uuid,
             $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
    [
      approvedId, input.workspaceId, row.opportunity_id, row.id, input.userId,
      row.tone, input.subject ?? row.subject, finalText, ratio, row.model ?? null,
      row.prompt_version, scheduledFor.toISOString(),
    ],
  );

  await db.query(
    `update actions set status = 'approved', updated_at = now() where id = $1::uuid`,
    [row.id],
  );

  await db.query(
    `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
     values ($1::uuid, 'user', $2::uuid, 'action.approved', 'action', $3, $4::jsonb)`,
    [input.workspaceId, input.userId, approvedId, JSON.stringify({ edit_ratio: ratio, draft_action_id: row.id })],
  );

  return { approvedActionId: approvedId, editRatio: ratio, scheduledFor: scheduledFor.toISOString() };
}

/** Snooze: the dossier comes back in 7 days. Not a contact — `last_touch_at` is untouched. */
export async function snoozeDraft(
  db: Db,
  input: { draftActionId: string; workspaceId: string; userId: string; now: Date; days?: number },
): Promise<void> {
  const days = input.days ?? 7;
  const until = new Date(input.now.getTime() + days * DAY);
  const res = await db.query<ActionRow>(
    `select * from actions where id = $1::uuid and workspace_id = $2::uuid and kind = 'draft_generated'`,
    [input.draftActionId, input.workspaceId],
  );
  const row = res.rows[0];
  if (!row) return;

  await db.query(
    `update actions set status = 'deferred', scheduled_for = $2::timestamptz, updated_at = now()
      where id = $1::uuid`,
    [row.id, until.toISOString()],
  );
  await db.query(
    `insert into actions
       (workspace_id, opportunity_id, parent_action_id, kind, status, actor_type, actor_user_id, scheduled_for)
     values ($1::uuid, $2::uuid, $3::uuid, 'deferred', 'deferred', 'user', $4::uuid, $5::timestamptz)`,
    [input.workspaceId, row.opportunity_id, row.id, input.userId, until.toISOString()],
  );
  await db.query(
    `update opportunities set expected_action_at = $2::timestamptz, updated_at = now()
      where id = $1::uuid and (expected_action_at is null or expected_action_at < $2::timestamptz)`,
    [row.opportunity_id, until.toISOString()],
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
     values ($1::uuid, 'user', $2::uuid, 'action.deferred', 'action', $3, $4::jsonb)`,
    [input.workspaceId, input.userId, row.id, JSON.stringify({ until: until.toISOString() })],
  );
}

/**
 * Dismiss. Two reasons have a side effect on the dossier, and both are the
 * customer's explicit instruction — never an inference from silence.
 */
export async function dismissDraft(
  db: Db,
  input: {
    draftActionId: string;
    workspaceId: string;
    userId: string;
    reason: 'not_relevant' | 'already_answered_elsewhere' | 'client_asked_to_stop' | 'other';
    now: Date;
  },
): Promise<void> {
  const res = await db.query<ActionRow>(
    `select * from actions where id = $1::uuid and workspace_id = $2::uuid and kind = 'draft_generated'`,
    [input.draftActionId, input.workspaceId],
  );
  const row = res.rows[0];
  if (!row) return;

  await db.query(
    `update actions set status = 'dismissed', dismissed_reason = $2, updated_at = now() where id = $1::uuid`,
    [row.id, input.reason],
  );
  await db.query(
    `insert into actions
       (workspace_id, opportunity_id, parent_action_id, kind, status, actor_type, actor_user_id, dismissed_reason)
     values ($1::uuid, $2::uuid, $3::uuid, 'dismissed', 'dismissed', 'user', $4::uuid, $5)`,
    [input.workspaceId, row.opportunity_id, row.id, input.userId, input.reason],
  );

  if (input.reason === 'not_relevant') {
    await db.query(
      `update opportunities set status = 'dormant', updated_at = now() where id = $1::uuid and status = 'open'`,
      [row.opportunity_id],
    );
  }
  if (input.reason === 'client_asked_to_stop') {
    await db.query(
      `update contacts set opt_out_at = now()
        where workspace_id = $1::uuid
          and id = (select contact_id from opportunities where id = $2::uuid)`,
      [input.workspaceId, row.opportunity_id],
    );
  }
  await db.query(
    `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
     values ($1::uuid, 'user', $2::uuid, 'action.dismissed', 'action', $3, $4::jsonb)`,
    [input.workspaceId, input.userId, row.id, JSON.stringify({ reason: input.reason })],
  );
}

// ---------------------------------------------------------------- sending

export interface DueAction {
  actionId: string;
  workspaceId: string;
  opportunityId: string;
  subject: string;
  body: string;
  retryCount: number;
}

/** The next approved action that is due, for one workspace. */
export async function nextDueAction(db: Db, workspaceId: string, now: Date): Promise<DueAction | null> {
  const res = await db.query<{
    id: string; workspace_id: string; opportunity_id: string; subject: string | null;
    final_text: string | null; retry_count: number;
  }>(
    `select id, workspace_id, opportunity_id, subject, final_text, retry_count
       from actions
      where workspace_id = $1::uuid
        and kind = 'approved'
        and status in ('approved','failed')
        and coalesce(scheduled_for, created_at) <= $2::timestamptz
        and retry_count < 2
      order by coalesce(scheduled_for, created_at) asc
      limit 1`,
    [workspaceId, now.toISOString()],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    actionId: row.id,
    workspaceId: row.workspace_id,
    opportunityId: row.opportunity_id,
    subject: row.subject ?? '',
    body: row.final_text ?? '',
    retryCount: row.retry_count,
  };
}

export interface SendCycleResult {
  status: 'idle' | 'sent' | 'cancelled' | 'failed' | 'already_sent' | 'not_approved';
  /** Drafts seen and refused because no human approved them (criterion 5). */
  skipped?: number;
  actionId?: string;
  code?: StopCode;
  sandbox?: boolean;
  to?: string;
  errorCode?: string;
}

/**
 * One action, one send, one transaction. Called by the cron route and by the
 * tests; nothing else is allowed to call a provider.
 */
export async function sendDueAction(
  db: Db,
  input: {
    workspaceId: string;
    provider: EmailProvider;
    now: Date;
    sandboxOwnerEmail: string;
    sandboxEnabled: boolean;
  },
): Promise<SendCycleResult> {
  const due = await nextDueAction(db, input.workspaceId, input.now);
  if (!due) {
    // Nothing approved. If a draft is sitting there, say so once — "the job ran
    // and sent nothing" must be explainable without reading the logs of a cron.
    const skipped = await logUnapprovedDrafts(db, input.workspaceId, input.now);
    return skipped > 0 ? { status: 'not_approved', skipped } : { status: 'idle' };
  }

  // Re-read the state now, not when the user approved: an hour may have passed.
  const snapshot = await loadOpportunity(db, due.opportunityId);
  if (!snapshot) return { status: 'idle' };

  const ws = await db.query<{ subscription_status: string }>(
    `select subscription_status from workspaces where id = $1::uuid`,
    [input.workspaceId],
  );
  const sendsToday = await db.query<{ n: string }>(
    `select count(*) as n from actions
      where workspace_id = $1::uuid and kind = 'sent' and sent_at >= date_trunc('day', $2::timestamptz)`,
    [input.workspaceId, input.now.toISOString()],
  );

  const state: SendState = {
    arm: snapshot.arm,
    opportunityStatus: snapshot.status,
    touchCount: snapshot.touch_count,
    lastTouchAt: snapshot.last_touch_at ? new Date(snapshot.last_touch_at) : null,
    replyReceivedAt: snapshot.reply_received_at ? new Date(snapshot.reply_received_at) : null,
    contactOptedOut: snapshot.opt_out_at !== null,
    contactBouncedAt: snapshot.bounced_at ? new Date(snapshot.bounced_at) : null,
    workspaceStatus: ws.rows[0]?.subscription_status ?? 'active',
    sendsToday: Number(sendsToday.rows[0]?.n ?? 0),
  };

  const result = await executeSend({
    action: {
      actionId: due.actionId,
      subject: due.subject,
      body: due.body,
      recipientEmail: snapshot.email,
    },
    state,
    provider: input.provider,
    sandbox: { enabled: input.sandboxEnabled, ownerEmail: input.sandboxOwnerEmail },
    now: input.now,
  });

  if (result.status === 'cancelled') {
    await db.query(
      `update actions set status = 'cancelled', error_code = $2, updated_at = now() where id = $1::uuid`,
      [due.actionId, result.code],
    );
    await db.query(
      `insert into actions
         (workspace_id, opportunity_id, parent_action_id, kind, status, actor_type, error_code)
       values ($1::uuid, $2::uuid, $3::uuid, 'cancelled', 'cancelled', 'system', $4)`,
      [input.workspaceId, due.opportunityId, due.actionId, result.code],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'action.skipped', 'action', $2, $3::jsonb)`,
      [input.workspaceId, due.actionId, JSON.stringify({ code: result.code, detail: result.detail })],
    );
    return { status: 'cancelled', actionId: due.actionId, code: result.code };
  }

  if (result.status === 'failed') {
    const attempt = await claimAttempt(db, input.workspaceId, due.actionId, result.providerName, false, {
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      sandbox: false,
    });
    if (!attempt) return { status: 'already_sent', actionId: due.actionId };
    await db.query(
      `update actions
          set status = 'failed', error_code = $2, error_message = $3,
              retry_count = retry_count + 1, updated_at = now()
        where id = $1::uuid`,
      [due.actionId, result.errorCode, result.errorMessage],
    );
    return { status: 'failed', actionId: due.actionId, errorCode: result.errorCode };
  }

  // Claim the attempt BEFORE marking the row as sent. If the unique constraint
  // refuses, another run already owns this send: do nothing else, ever.
  const attempt = await claimAttempt(db, input.workspaceId, due.actionId, result.providerName, true, {
    providerMessageId: result.providerMessageId,
    sandbox: result.sandbox,
  });
  if (!attempt) return { status: 'already_sent', actionId: due.actionId };

  await db.query(
    `update actions
        set status = 'sent', sent_at = $2::timestamptz, provider = $3,
            provider_message_id = $4, sandbox = $5, updated_at = now()
      where id = $1::uuid`,
    [due.actionId, input.now.toISOString(), result.providerName, result.providerMessageId ?? null, result.sandbox],
  );

  // The event row that makes the lifecycle readable as three rows (§5).
  await db.query(
    `insert into actions
       (workspace_id, opportunity_id, parent_action_id, kind, status, actor_type, subject, final_text,
        provider, provider_message_id, sandbox, sent_at)
     values ($1::uuid, $2::uuid, $3::uuid, 'sent', 'sent', 'system', $4, $5, $6, $7, $8, $9::timestamptz)`,
    [
      input.workspaceId, due.opportunityId, due.actionId, due.subject, due.body,
      result.providerName, result.providerMessageId ?? null, result.sandbox, input.now.toISOString(),
    ],
  );

  // Sandbox sends are visible in the audit trail but do not count as a contact:
  // the client never saw them, so incrementing touch_count would corrupt scoring
  // and the holdout comparison (criterion 9).
  if (!result.sandbox) {
    await db.query(
      `update opportunities
          set touch_count = least(touch_count + 1, 3),
              last_touch_at = $2::timestamptz,
              annoyed = (touch_count + 1 > 1 and annoyed),
              updated_at = now()
        where id = $1::uuid`,
      [due.opportunityId, input.now.toISOString()],
    );
  }

  await db.query(
    `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
     values ($1::uuid, 'system', $2, 'action', $3, $4::jsonb)`,
    [
      input.workspaceId,
      result.sandbox ? 'action.sent_sandbox' : 'action.sent',
      due.actionId,
      JSON.stringify({
        // The final text, never the draft: this is what the client received.
        final_text: due.body,
        subject: due.subject,
        to: result.to,
        provider: result.providerName,
        provider_message_id: result.providerMessageId ?? null,
        sandbox: result.sandbox,
      }),
    ],
  );

  return { status: 'sent', actionId: due.actionId, sandbox: result.sandbox, to: result.to };
}

/** Insert the attempt; returns null when this action/attempt already exists. */
async function claimAttempt(
  db: Db,
  workspaceId: string,
  actionId: string,
  provider: string,
  ok: boolean,
  extra: { providerMessageId?: string; errorCode?: string; errorMessage?: string; sandbox: boolean },
): Promise<string | null> {
  const attempt = await db.query<{ next: number }>(
    `select coalesce(max(attempt), 0) + 1 as next from send_attempts where action_id = $1::uuid`,
    [actionId],
  );
  const next = Number(attempt.rows[0]?.next ?? 1);
  const inserted = await db.query<{ id: string }>(
    `insert into send_attempts
       (workspace_id, action_id, attempt, provider, idempotency_key, provider_message_id, ok, error_code, error_message, sandbox)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (action_id, attempt) do nothing
     returning id`,
    [
      workspaceId, actionId, next, provider, actionId,
      extra.providerMessageId ?? null, ok, extra.errorCode ?? null, extra.errorMessage ?? null, extra.sandbox,
    ],
  );
  return inserted.rows[0]?.id ?? null;
}

/**
 * Criterion 5 — "no approval, no send". The job cannot see a draft as work, so the
 * guarantee is structural; this function exists only to leave a trace. One audit
 * row per draft per day, otherwise a 5-minute cron would bury the trail.
 */
async function logUnapprovedDrafts(db: Db, workspaceId: string, now: Date): Promise<number> {
  const drafts = await db.query<{ id: string; opportunity_id: string }>(
    `select a.id, a.opportunity_id
       from actions a
      where a.workspace_id = $1::uuid
        and a.kind = 'draft_generated' and a.status = 'draft'
        and not exists (
          select 1 from audit_log l
           where l.action = 'action.skipped'
             and l.entity_id = a.id::text
             and l.after->>'code' = 'skipped_not_approved'
             and l.created_at >= $2::timestamptz - interval '24 hours')
      limit 20`,
    [workspaceId, now.toISOString()],
  );
  for (const d of drafts.rows) {
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'action.skipped', 'action', $2, $3::jsonb)`,
      [workspaceId, d.id, JSON.stringify({ code: 'skipped_not_approved', opportunity_id: d.opportunity_id })],
    );
  }
  return drafts.rows.length;
}

/** Was this action already sent? Used by the idempotency test and the UI. */
export async function wasSent(db: Db, actionId: string): Promise<boolean> {
  const res = await db.query<{ n: string }>(
    `select count(*) as n from send_attempts where action_id = $1::uuid and ok`,
    [actionId],
  );
  return Number(res.rows[0]?.n ?? 0) > 0;
}
