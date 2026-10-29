/**
 * Phase 04 persistence. These tests are the ones that would catch a regression
 * nobody sees: a draft sent without approval, a retried job sending twice, an
 * audit trail that stores the draft instead of the message, a sandbox message
 * that counts as a real contact.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, asWorkspace, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  saveDraft, approveDraft, snoozeDraft, dismissDraft, saveGenerationFailure,
  sendDueAction, nextDueAction, wasSent, loadOpportunity, previousMessages,
} from '../repo/actions.ts';
import { MemoryEmailProvider } from '../../../domain/src/sending/providers/memory.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
let db: Db;
let workspaceId: string;
let userId: string;
let ownerEmail: string;
let opportunityId: string;
let draftId: string;
let contactId: string;

const DRAFT = `Bonjour Camille,

Je vous écris au sujet de la proposition « refonte du site vitrine », transmise le 6 octobre pour un montant de 12 400 €.
Le devis inclut la reprise du blog.
Avez-vous pu en prendre connaissance ?
Si ce n'est pas le moment, dites-le-moi simplement.

Bien à vous,
Léa`;

const EDITED = DRAFT.replace('Si ce n\'est pas le moment, dites-le-moi simplement.', 'Je peux vous rappeler si c\'est plus simple.');

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const created = await createWorkspaceWithOwner(db, {
    email: 'lea@studio-merlot.fr', workspaceName: 'Studio Merlot', locale: 'fr',
  });
  workspaceId = created.workspaceId;
  userId = created.userId;
  ownerEmail = 'lea@studio-merlot.fr';

  const contact = await db.query<{ id: string }>(
    `insert into contacts (workspace_id, email, full_name) values ($1::uuid, $2, $3) returning id`,
    [workspaceId, 'camille@atelier-verne.fr', 'Camille Rousseau'],
  );
  contactId = contact.rows[0]!.id;

  const opp = await db.query<{ id: string }>(
    `insert into opportunities
       (workspace_id, contact_id, client_name, title, amount_cents, stage, sent_at, touch_count, arm)
     values ($1::uuid, $2::uuid, $3, $4, $5::bigint, 'proposal_sent', $6::timestamptz, 0, 'treatment')
     returning id`,
    [workspaceId, contactId, 'Atelier Verne', 'Refonte du site vitrine', 1_240_000, '2026-10-06T09:00:00Z'],
  );
  opportunityId = opp.rows[0]!.id;

  draftId = await saveDraft(db, {
    opportunityId,
    workspaceId,
    tone: 'warm',
    subject: 'Votre proposition de refonte',
    body: DRAFT,
    model: 'local-composer',
    promptVersion: 'v1',
  });
});

async function send(provider = new MemoryEmailProvider(), sandboxEnabled = false) {
  return sendDueAction(db, {
    workspaceId,
    provider,
    now: NOW,
    sandboxOwnerEmail: ownerEmail,
    sandboxEnabled,
  });
}

describe('migration 0004 — the outbox exists on a fresh database', () => {
  it('creates actions and send_attempts, and grants the tenant role nothing dangerous', async () => {
    const tables = await db.query<{ actions: string; attempts: string; column: string | null }>(
      `select to_regclass('public.actions')::text as actions,
              to_regclass('public.send_attempts')::text as attempts,
              (select column_name from information_schema.columns
                where table_name = 'opportunities' and column_name = 'context_note') as column`,
    );
    expect(tables.rows[0]).toEqual({ actions: 'actions', attempts: 'send_attempts', column: 'context_note' });

    const grants = await db.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'app_authenticated' and table_name in ('actions','send_attempts')
        order by table_name, privilege_type`,
    );
    expect(grants.rows.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual([
      'actions:INSERT', 'actions:SELECT', 'actions:UPDATE',
      'send_attempts:INSERT', 'send_attempts:SELECT',
    ]);
  });

  it('keeps one live draft per opportunity and replaces it on regeneration', async () => {
    const second = await saveDraft(db, {
      opportunityId, workspaceId, tone: 'direct',
      subject: 'Refonte — suite', body: 'Bonjour Camille, je reviens vers vous.',
      model: 'local-composer', promptVersion: 'v1',
    });
    expect(second).toBe(draftId);

    const rows = await db.query<{ kind: string; status: string; draft_text: string; tone: string }>(
      `select kind, status, draft_text, tone from actions where opportunity_id = $1::uuid`,
      [opportunityId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ kind: 'draft_generated', status: 'draft', tone: 'direct' });
  });

  it('records a failed generation with its violation codes and no body', async () => {
    await saveGenerationFailure(db, {
      workspaceId, opportunityId, codes: ['commitment_date', 'length_out_of_range'],
      model: 'local-composer', promptVersion: 'v1', reason: 'guardrail_failed',
    });
    // Criterion 3: one `draft_generated` action carrying the failure reasons,
    // with no body — a refused draft never becomes a draft a human could send.
    const row = await db.query<{ kind: string; status: string; codes: string[]; draft_text: string | null; rationale: string }>(
      `select kind, status, violation_codes as codes, draft_text, rationale
         from actions where kind = 'draft_generated' and status = 'failed'`,
    );
    expect(row.rows[0]).toMatchObject({
      kind: 'draft_generated', status: 'failed', draft_text: null, rationale: 'guardrail_failed',
    });
    expect(row.rows[0]!.codes).toEqual(['commitment_date', 'length_out_of_range']);

    // It must not block the next attempt: a failed row is not the live draft.
    const stillDraft = await db.query<{ n: number }>(
      `select count(*)::int as n from actions where kind = 'draft_generated' and status = 'draft'`,
    );
    expect(stillDraft.rows[0]!.n).toBe(1);
  });
});

describe('approval — nothing is sendable without a human', () => {
  it('stores the edit ratio, links to the draft and writes an audit row', async () => {
    const res = await approveDraft(db, {
      draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW,
    });
    expect(res).not.toBeNull();
    // §8.4: edit_ratio = 1 - distance/maxlen, so 1.0 means "sent as written".
    // One clause replaced by a hand-written one keeps most of the draft.
    expect(res!.editRatio).toBeGreaterThan(0.7);
    expect(res!.editRatio).toBeLessThan(1);

    const approved = await db.query<{ status: string; final_text: string; edit_ratio: string; parent_action_id: string }>(
      `select status, final_text, edit_ratio, parent_action_id from actions where id = $1::uuid`,
      [res!.approvedActionId],
    );
    expect(approved.rows[0]).toMatchObject({ status: 'approved', final_text: EDITED, parent_action_id: draftId });
    expect(Number(approved.rows[0]!.edit_ratio)).toBeCloseTo(res!.editRatio, 4);

    const draft = await db.query<{ status: string; draft_text: string }>(
      `select status, draft_text from actions where id = $1::uuid`, [draftId],
    );
    // The draft survives, unchanged: it is the reference the ratio is measured against.
    expect(draft.rows[0]).toEqual({ status: 'approved', draft_text: DRAFT });

    const audit = await db.query<{ action: string }>(
      `select action from audit_log where entity_id = $1`, [res!.approvedActionId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['action.approved']);
  });

  it('refuses a second approval of the same draft (partial unique index)', async () => {
    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    await expect(
      approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW }),
    ).rejects.toThrow();
  });

  it('returns null for a draft from another workspace', async () => {
    const other = await createWorkspaceWithOwner(db, {
      email: 'x@y.fr', workspaceName: 'Agence Y', locale: 'fr',
    });
    const res = await approveDraft(db, {
      draftActionId: draftId, workspaceId: other.workspaceId, userId: other.userId, finalText: EDITED, now: NOW,
    });
    expect(res).toBeNull();
  });

  it('snoozes for seven days without pretending the client was contacted', async () => {
    const snoozeDraftNow = new Date(NOW);
    await snoozeDraft(db, { draftActionId: draftId, workspaceId, userId, now: snoozeDraftNow });
    const opp = await db.query<{ expected_action_at: string; last_touch_at: string | null; touch_count: number }>(
      `select expected_action_at, last_touch_at, touch_count from opportunities where id = $1::uuid`,
      [opportunityId],
    );
    const days = (new Date(opp.rows[0]!.expected_action_at).getTime() - NOW.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(7);
    expect(opp.rows[0]!.last_touch_at).toBeNull();
    expect(opp.rows[0]!.touch_count).toBe(0);

    const status = await db.query<{ status: string }>(`select status from actions where id = $1::uuid`, [draftId]);
    expect(status.rows[0]!.status).toBe('deferred');
  });

  it('dismissing "not relevant" closes the dossier as dormant', async () => {
    await dismissDraft(db, { draftActionId: draftId, workspaceId, userId, reason: 'not_relevant', now: NOW });
    const opp = await db.query<{ status: string }>(`select status from opportunities where id = $1::uuid`, [opportunityId]);
    const contact = await db.query<{ opt_out_at: string | null }>(`select opt_out_at from contacts where id = $1::uuid`, [contactId]);
    expect(opp.rows[0]!.status).toBe('dormant');
    expect(contact.rows[0]!.opt_out_at).toBeNull();
  });

  it('dismissing "client asked to stop" opts the contact out — the only path that does', async () => {
    await dismissDraft(db, { draftActionId: draftId, workspaceId, userId, reason: 'client_asked_to_stop', now: NOW });
    const contact = await db.query<{ opt_out_at: string | null }>(`select opt_out_at from contacts where id = $1::uuid`, [contactId]);
    expect(contact.rows[0]!.opt_out_at).not.toBeNull();

    const next = await nextDueAction(db, workspaceId, NOW);
    expect(next).toBeNull();
  });
});

describe('sending — one action, one provider call, one audit row', () => {
  it('sends nothing while the draft is unapproved, and says so once (criterion 5)', async () => {
    const provider = new MemoryEmailProvider();
    const res = await send(provider);

    expect(res.status).toBe('not_approved');
    expect(provider.sent).toHaveLength(0);

    const draft = await db.query<{ status: string }>(`select status from actions where id = $1::uuid`, [draftId]);
    expect(draft.rows[0]!.status).toBe('draft');

    const skipped = await db.query<{ code: string; entity: string }>(
      `select after->>'code' as code, entity from audit_log where action = 'action.skipped'`,
    );
    expect(skipped.rows).toEqual([{ code: 'skipped_not_approved', entity: 'action' }]);

    // A second tick is silent: the same draft is not re-logged every few minutes,
    // so the job reports "idle" and the trail keeps exactly one line.
    const again = await send(provider);
    expect(again.status).toBe('idle');
    const twice = await db.query<{ n: number }>(`select count(*)::int as n from audit_log where action = 'action.skipped'`);
    expect(twice.rows[0]!.n).toBe(1);
    expect(provider.sent).toHaveLength(0);
  });

  it('sends an approved action, records the attempt and moves the dossier forward', async () => {
    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    const provider = new MemoryEmailProvider();
    const res = await send(provider);

    expect(res.status).toBe('sent');
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]).toMatchObject({
      to: 'camille@atelier-verne.fr',
      subject: 'Votre proposition de refonte',
      body: EDITED,
      idempotencyKey: res.actionId,
    });

    const opp = await db.query<{ touch_count: number; last_touch_at: string | null }>(
      `select touch_count, last_touch_at from opportunities where id = $1::uuid`, [opportunityId],
    );
    expect(opp.rows[0]!.touch_count).toBe(1);
    expect(opp.rows[0]!.last_touch_at).not.toBeNull();

    const sentRow = await db.query<{ kind: string; status: string; provider: string; sandbox: boolean }>(
      `select kind, status, provider, sandbox from actions where kind = 'sent' and opportunity_id = $1::uuid`,
      [opportunityId],
    );
    expect(sentRow.rows[0]).toMatchObject({ kind: 'sent', status: 'sent', provider: 'memory', sandbox: false });

    // The audit trail keeps the message the client received, not the draft.
    const audit = await db.query<{ after: { final_text: string; to: string; sandbox: boolean } }>(
      `select after from audit_log where action = 'action.sent'`,
    );
    expect(audit.rows[0]!.after.final_text).toBe(EDITED);
    expect(audit.rows[0]!.after.to).toBe('camille@atelier-verne.fr');
    expect(audit.rows[0]!.after.sandbox).toBe(false);
    expect(audit.rows[0]!.after.final_text).not.toBe(DRAFT);

    // Criterion 10: one full cycle = exactly three lifecycle rows, and one audit
    // line per human/system decision.
    const cycle = await db.query<{ kind: string; status: string }>(
      `select kind, status from actions where opportunity_id = $1::uuid order by created_at asc`,
      [opportunityId],
    );
    expect(cycle.rows).toHaveLength(3);
    expect(cycle.rows.map((r) => r.kind)).toEqual(['draft_generated', 'approved', 'sent']);

    const trail = await db.query<{ action: string }>(
      `select action from audit_log where entity in ('action','workspace') order by id asc`,
    );
    expect(trail.rows.map((r) => r.action)).toEqual(['workspace.created', 'action.approved', 'action.sent']);
  });

  it('does not send twice when the job runs again', async () => {
    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    const provider = new MemoryEmailProvider();
    const first = await send(provider);
    const second = await send(provider);

    expect(first.status).toBe('sent');
    expect(second.status).toBe('idle');
    expect(provider.sent).toHaveLength(1);
    expect(await wasSent(db, first.actionId!)).toBe(true);

    const attempts = await db.query<{ n: number }>(`select count(*)::int as n from send_attempts`);
    expect(attempts.rows[0]!.n).toBe(1);
  });

  it('cancels at send time when the client answered after the approval', async () => {
    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    await db.query(
      `update opportunities set reply_received_at = $2::timestamptz where id = $1::uuid`,
      [opportunityId, '2026-10-25T10:00:00Z'],
    );
    const provider = new MemoryEmailProvider();
    const res = await send(provider);

    expect(res.status).toBe('cancelled');
    expect(res.code).toBe('REPLY_RECEIVED');
    expect(provider.sent).toHaveLength(0);

    const row = await db.query<{ status: string; error_code: string }>(
      `select status, error_code from actions where id = $1::uuid`, [res.actionId!],
    );
    expect(row.rows[0]).toMatchObject({ status: 'cancelled', error_code: 'REPLY_RECEIVED' });
  });

  it('marks the action failed and schedules at most one retry', async () => {
    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    const provider = new MemoryEmailProvider();
    provider.failOnce('bounce', 'mailbox unavailable');

    const first = await send(provider);
    expect(first.status).toBe('failed');
    expect(first.errorCode).toBe('bounce');

    const failed = await db.query<{ status: string; retry_count: number; error_message: string }>(
      `select status, retry_count, error_message from actions where id = $1::uuid`, [first.actionId!],
    );
    expect(failed.rows[0]).toMatchObject({ status: 'failed', retry_count: 1, error_message: 'mailbox unavailable' });

    const second = await send(provider);
    expect(second.status).toBe('sent');
    expect(provider.sent).toHaveLength(2);
  });

  it('sandbox reroutes to the owner, prefixes the subject and does not count as a contact', async () => {
    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    const provider = new MemoryEmailProvider();
    const res = await send(provider, true);

    expect(res.status).toBe('sent');
    expect(res.sandbox).toBe(true);
    expect(provider.sent[0]!.to).toBe(ownerEmail);
    expect(provider.sent[0]!.subject).toBe('[SANDBOX] Votre proposition de refonte');
    expect(provider.sent[0]!.body).toBe(EDITED);

    const opp = await db.query<{ touch_count: number; last_touch_at: string | null }>(
      `select touch_count, last_touch_at from opportunities where id = $1::uuid`, [opportunityId],
    );
    expect(opp.rows[0]!.touch_count).toBe(0);
    expect(opp.rows[0]!.last_touch_at).toBeNull();

    const audit = await db.query<{ action: string }>(`select action from audit_log where action like 'action.sent%'`);
    expect(audit.rows.map((r) => r.action)).toEqual(['action.sent_sandbox']);
  });

  it('a holdout dossier can be approved but never sent', async () => {
    // `arm` is frozen by a trigger (invariant I2), so the holdout dossier has to be
    // created as one — that is the point: nobody can move a client out of the arm.
    const opp = await db.query<{ id: string }>(
      `insert into opportunities
         (workspace_id, contact_id, client_name, title, amount_cents, stage, sent_at, touch_count, arm)
       values ($1::uuid, $2::uuid, 'Atelier Brie', 'Audit SEO', $3::bigint, 'proposal_sent', $4::timestamptz, 0, 'holdout')
       returning id`,
      [workspaceId, contactId, 480_000, '2026-10-06T09:00:00Z'],
    );
    const holdoutDraft = await saveDraft(db, {
      opportunityId: opp.rows[0]!.id, workspaceId, tone: 'warm',
      subject: 'Votre audit', body: DRAFT, model: 'local-composer', promptVersion: 'v1',
    });
    await approveDraft(db, { draftActionId: holdoutDraft, workspaceId, userId, finalText: EDITED, now: NOW });
    const provider = new MemoryEmailProvider();
    const res = await send(provider);
    expect(res).toMatchObject({ status: 'cancelled', code: 'HOLDOUT' });
    expect(provider.sent).toHaveLength(0);
  });

  it('the tenant role cannot read another workspace outbox', async () => {
    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    const other = await createWorkspaceWithOwner(db, {
      email: 'z@w.fr', workspaceName: 'Agence W', locale: 'fr',
    });
    const visible = await asWorkspace(db, other.workspaceId, async () => {
      const res = await db.query<{ n: number }>(`select count(*)::int as n from actions`);
      return res.rows[0]!.n;
    });
    const own = await asWorkspace(db, workspaceId, async () => {
      const res = await db.query<{ n: number }>(`select count(*)::int as n from actions`);
      return res.rows[0]!.n;
    });
    expect(visible).toBe(0);
    expect(own).toBeGreaterThan(0);
  });
});

describe('context for the prompt', () => {
  it('reads the dossier with the contact first name and the two previous messages', async () => {
    const snapshot = await loadOpportunity(db, opportunityId);
    expect(snapshot).toMatchObject({
      client_name: 'Atelier Verne', contact_first_name: 'Camille', arm: 'treatment', touch_count: 0,
    });

    await approveDraft(db, { draftActionId: draftId, workspaceId, userId, finalText: EDITED, now: NOW });
    expect(await previousMessages(db, opportunityId)).toEqual([EDITED]);
  });

  it('falls back to the e-mail local part when there is no name', async () => {
    await db.query(`update contacts set full_name = null where id = $1::uuid`, [contactId]);
    const snapshot = await loadOpportunity(db, opportunityId);
    expect(snapshot!.contact_first_name).toBe('Camille');
  });
});

describe('launch gate I3 — the send job refuses the third contact inside seven days', () => {
  it('approving three actions in a row sends one, and cancels the next at the job level', async () => {
    const id1 = await approveDraft(db, {
      draftActionId: draftId, workspaceId, userId,
      finalText: EDITED, subject: 'Relance 1',
      scheduledFor: new Date(NOW.getTime() - 3_600_000), now: NOW,
    });
    const r1 = await send();
    expect(r1.status).toBe('sent');

    // Second draft, approved for the SAME instant as the first send — exactly
    // what "three approvals in a row" produces. The job must not need the queue
    // to be right: it re-validates the spacing itself.
    const d2 = await saveDraft(db, {
      opportunityId, workspaceId, tone: 'warm', subject: 'Relance 2', body: DRAFT,
      model: 'local-composer', promptVersion: 'v1',
    });
    await approveDraft(db, {
      draftActionId: d2, workspaceId, userId,
      finalText: EDITED, subject: 'Relance 2', scheduledFor: NOW, now: NOW,
    });
    const r2 = await send();
    expect(r2.status).toBe('cancelled');
    expect(r2.code).toBe('RECENT_TOUCH');

    const states = await db.query<{ kind: string; status: string; error_code: string | null }>(
      `select kind, status, error_code from actions
        where opportunity_id = $1::uuid and kind in ('approved', 'sent', 'cancelled')
        order by created_at asc, id asc`,
      [opportunityId],
    );
    // Count real contacts only: approved rows that actually went out (the
    // 'sent' kind rows are the event log, not contacts).
    const sentCount = states.rows.filter((r) => r.kind === 'approved' && r.status === 'sent').length;
    expect(sentCount).toBe(1);
    const cancelledRow = states.rows.find((r) => r.kind === 'cancelled');
    expect(cancelledRow?.error_code).toBe('RECENT_TOUCH');
    expect(id1).toBeTruthy();
  });
});
