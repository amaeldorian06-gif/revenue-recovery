import { getSession, type Session } from './session';
import { withTenant } from './db';
import { isoDate } from '@rros/db/queue';
import type { QueueItemView } from '@rros/db/queue';
import { readQueue } from '@rros/db/queue';
import {
  loadOpportunity, previousMessages, saveDraft, saveManualDraft, saveGenerationFailure,
} from '@rros/db/actions';
import { buildContext, type BuildContextInput, type Tone } from '@rros/domain/drafting/context';
import { generateDraft, type LlmProvider } from '@rros/domain/drafting/generate';
import { PROMPT_VERSION } from '@rros/domain/drafting/prompts/v1';
import { defaultProvider } from '@rros/domain/drafting/providers/index';
import { violationCodes } from '@rros/domain/drafting/guardrails';
import { STOP_RULES } from '@rros/domain/sending/stopRules';

export type { Tone };

export interface DraftState {
  /** `none` = nothing generated yet; `failed` = generation refused twice. */
  status: 'none' | 'draft' | 'failed' | 'approved' | 'sent' | 'deferred' | 'dismissed' | 'cancelled';
  actionId: string | null;
  subject: string;
  body: string;
  tone: Tone;
  reason: string | null;
  violations: string[];
  providerCalls: number;
  model: string;
  promptVersion: string;
  editRatio: number | null;
  finalText: string | null;
  /** When the latest row in the lifecycle was written. */
  at: string | null;
  sandbox: boolean;
  nextFollowUpDays: number;
  /** True when the editor holds the facts skeleton, not a generated message. */
  manual: boolean;
}

export interface CardData {
  item: QueueItemView;
  draft: DraftState;
  opportunity: {
    clientName: string;
    title: string | null;
    amountCents: number;
    sentAt: string;
    touchCount: number;
    contactEmail: string | null;
    contactFirstName: string | null;
    replyReceivedAt: string | null;
  };
}

const DAY = 86_400_000;

function emptyDraft(tone: Tone = 'warm'): DraftState {
  return {
    status: 'none', actionId: null, subject: '', body: '', tone,
    reason: null, violations: [], providerCalls: 0,
    model: '', promptVersion: PROMPT_VERSION, editRatio: null, finalText: null,
    sandbox: false, nextFollowUpDays: STOP_RULES.MIN_DAYS_BETWEEN_TOUCHES, manual: false, at: null,
  };
}

async function currentDraft(session: Session, opportunityId: string): Promise<DraftState | null> {
  return withTenant(session.workspaceId, async (db) => {
    const res = await db.query<{
      id: string; kind: string; status: string; subject: string | null; draft_text: string | null;
      final_text: string | null; tone: string | null; violation_codes: string[];
      rationale: string | null; model: string | null; prompt_version: string; edit_ratio: string | null;
      sandbox: boolean; created_at: string;
    }>(
      `select id, kind, status, subject, draft_text, final_text, tone, violation_codes,
              rationale, model, prompt_version, edit_ratio, sandbox, created_at
         from actions
        where opportunity_id = $1::uuid
        order by created_at desc
        limit 1`,
      [opportunityId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      status: (row.status === 'failed' ? 'failed' : row.status) as DraftState['status'],
      actionId: row.status === 'draft' ? row.id : null,
      subject: row.subject ?? '',
      body: row.draft_text ?? row.final_text ?? '',
      tone: (row.tone as Tone) ?? 'warm',
      reason: row.rationale,
      violations: row.violation_codes ?? [],
      providerCalls: 0,
      model: row.model ?? '',
      promptVersion: row.prompt_version,
      editRatio: row.edit_ratio === null ? null : Number(row.edit_ratio),
      finalText: row.final_text,
      sandbox: row.sandbox,
      at: row.created_at,
      nextFollowUpDays: STOP_RULES.MIN_DAYS_BETWEEN_TOUCHES,
      manual: row.model === 'manual-skeleton',
    };
  });
}

/**
 * The signature belongs to a person, not to a login. A generated id such as
 * `pbe863f` signs nothing; in that case we sign as the team rather than invent a
 * founder.
 */
function senderName(
  fullName: string | null,
  email: string,
  workspaceName: string,
  locale: 'fr' | 'en',
): string {
  const candidate = (fullName ?? '').trim();
  const human = candidate !== '' && !/\d/.test(candidate.split(/\s+/)[0] ?? '') && candidate.length <= 40;
  if (human) return candidate;
  return locale === 'fr' ? `L’équipe ${workspaceName}` : `the ${workspaceName} team`;
}

/** The queue row for a dossier, today. Null when it is not in today's queue. */
export async function queueItemFor(session: Session, opportunityId: string): Promise<QueueItemView | null> {
  const items = await withTenant(session.workspaceId, (db) =>
    readQueue(db, session.workspaceId, isoDate(new Date())),
  );
  return items.find((i) => i.opportunityId === opportunityId) ?? null;
}

/**
 * Generate one draft, or explain why not. Never throws: the screen has to render
 * either way, and the manual path is a product requirement, not a fallback.
 */
export async function generateFor(
  session: Session,
  opportunityId: string,
  tone: Tone = 'warm',
  providerOverride?: LlmProvider,
): Promise<DraftState> {
  const data = await withTenant(session.workspaceId, async (db) => {
    const snapshot = await loadOpportunity(db, opportunityId);
    const previous = await previousMessages(db, opportunityId);
    const ws = await db.query<{ name: string; full_name: string | null }>(
      `select w.name, u.full_name
         from workspaces w
         left join users u on u.workspace_id = w.id and u.id = $2::uuid
        where w.id = $1::uuid`,
      [session.workspaceId, session.userId],
    );
    return {
      snapshot,
      previous,
      workspaceName: ws.rows[0]?.name ?? '',
      ownerName: ws.rows[0]?.full_name ?? null,
    };
  });

  if (!data.snapshot) return { ...emptyDraft(tone), reason: 'not_found' };

  const snapshot = data.snapshot;
  const contactLocale = (snapshot.contact_locale as 'fr' | 'en' | null) ?? null;
  const input = {
    opportunity: {
      clientName: snapshot.client_name,
      title: snapshot.title,
      amountCents: Number(snapshot.amount_cents),
      sentAt: new Date(snapshot.sent_at),
      stage: snapshot.stage,
      touchCount: snapshot.touch_count,
      lastTouchAt: snapshot.last_touch_at ? new Date(snapshot.last_touch_at) : null,
      contextNote: snapshot.context_note,
    },
    contact: {
      firstName: snapshot.contact_first_name,
      email: snapshot.email,
      locale: contactLocale,
    },
    previousMessages: data.previous,
    tone,
    locale: session.locale,
    senderName: senderName(data.ownerName, session.email, data.workspaceName, session.locale),
    now: new Date(),
  } satisfies BuildContextInput;

  const ctx = buildContext(input);

  if (!ctx.ok) {
    await withTenant(session.workspaceId, (db) =>
      saveGenerationFailure(db, {
        workspaceId: session.workspaceId,
        opportunityId,
        codes: ['insufficient_context'],
        model: 'none',
        promptVersion: PROMPT_VERSION,
        reason: 'insufficient_context',
      }),
    );
    const skeleton = await ensureManualDraft(session, opportunityId, snapshot, tone);
    return { ...skeleton, reason: 'insufficient_context', violations: ['insufficient_context'], providerCalls: 0 };
  }

  const result = await generateDraft({ context: input, provider: providerOverride ?? defaultProvider() });

  if (!result.draft) {
    await withTenant(session.workspaceId, (db) =>
      saveGenerationFailure(db, {
        workspaceId: session.workspaceId,
        opportunityId,
        codes: violationCodes(result.violations),
        model: 'local-composer',
        promptVersion: PROMPT_VERSION,
        reason: result.reason ?? 'guardrail_failed',
      }),
    );
    // Degrade to the manual path immediately: the screen must be usable even when
    // the writer has nothing defensible to say.
    const skeleton = await ensureManualDraft(session, opportunityId, snapshot, tone);
    return {
      ...skeleton,
      status: 'draft',
      reason: result.reason ?? 'guardrail_failed',
      violations: violationCodes(result.violations),
      providerCalls: result.providerCalls,
      manual: true,
    };
  }

  const actionId = await withTenant(session.workspaceId, (db) =>
    saveDraft(db, {
      opportunityId,
      workspaceId: session.workspaceId,
      tone,
      subject: result.draft!.subject,
      body: result.draft!.body,
      rationale: null,
      model: result.draft!.model,
      promptVersion: result.draft!.promptVersion,
    }),
  );

  return {
    status: 'draft',
    actionId,
    subject: result.draft.subject,
    body: result.draft.body,
    tone,
    reason: null,
    violations: [],
    providerCalls: result.providerCalls,
    model: result.draft.model,
    promptVersion: result.draft.promptVersion,
    editRatio: null,
    finalText: null,
    sandbox: false,
    nextFollowUpDays: STOP_RULES.MIN_DAYS_BETWEEN_TOUCHES,
    manual: false,
    at: null,
  };
}

/** Facts in the right order: who, what, when, how much, one question, a signature. */
async function ensureManualDraft(
  session: Session,
  opportunityId: string,
  snapshot: { client_name: string; title: string | null; amount_cents: string; sent_at: string; context_note: string | null; contact_first_name: string | null },
  tone: Tone,
): Promise<DraftState> {
  const fr = session.locale === 'fr';
  const amount = new Intl.NumberFormat(fr ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(Number(snapshot.amount_cents) / 100);
  const date = new Date(snapshot.sent_at).toLocaleDateString(fr ? 'fr-FR' : 'en-GB', {
    day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  const hello = snapshot.contact_first_name ? `Bonjour ${snapshot.contact_first_name},` : 'Bonjour,';
  const subject = fr
    ? `Suite à notre proposition — ${snapshot.title ?? snapshot.client_name}`
    : `Following up on our proposal — ${snapshot.title ?? snapshot.client_name}`;
  const body = fr
    ? `${hello}

Je reviens vers vous au sujet de ${snapshot.title ?? 'notre proposition'}, transmise le ${date} pour un montant de ${amount}.${
        snapshot.context_note ? `\n${snapshot.context_note}` : ''
      }

Avez-vous pu en prendre connaissance ?

Bien à vous,`
    : `${snapshot.contact_first_name ? `Hello ${snapshot.contact_first_name},` : 'Hello,'}

I am following up on ${snapshot.title ?? 'our proposal'}, sent on ${date} for ${amount}.${
        snapshot.context_note ? `\n${snapshot.context_note}` : ''
      }

Have you had a chance to look at it?

Best regards,`;

  const actionId = await withTenant(session.workspaceId, (db) =>
    saveManualDraft(db, { workspaceId: session.workspaceId, opportunityId, subject, body }),
  );
  return {
    ...emptyDraft(tone),
    status: 'draft',
    actionId,
    subject,
    body,
    model: 'manual-skeleton',
    promptVersion: 'manual',
    manual: true,
    at: new Date().toISOString(),
  };
}

/** The whole card: facts, meters (from the queue row) and the draft, created on demand. */
export async function loadCard(session: Session, opportunityId: string): Promise<CardData | null> {
  const item = await queueItemFor(session, opportunityId);
  const opportunity = await withTenant(session.workspaceId, (db) => loadOpportunity(db, opportunityId));
  if (!opportunity) return null;

  const existing = await currentDraft(session, opportunityId);
  // Only a live draft (or nothing) leads to generation. A sent, approved, snoozed
  // or dismissed dossier is finished work: reopening it must not silently write a
  // new message behind the user's back.
  const draft = !existing
    ? await generateFor(session, opportunityId, 'warm')
    : existing.status === 'draft' && existing.body.trim() !== ''
    ? existing
    : existing.status === 'draft' || existing.status === 'failed'
    ? await generateFor(session, opportunityId, existing.tone as Tone)
    : existing;

  const facts = {
    clientName: opportunity.client_name,
    title: opportunity.title,
    amountCents: Number(opportunity.amount_cents),
    sentAt: opportunity.sent_at,
    touchCount: opportunity.touch_count,
    contactEmail: opportunity.email,
    contactFirstName: opportunity.contact_first_name,
    replyReceivedAt: opportunity.reply_received_at,
  };

  if (!item) {
    // Not in today's queue (already acted, or capacity). Still render the dossier so
    // a bookmarked card never 404s — the meters just show zero.
    return {
      item: {
        opportunityId, rank: 0, priorityIndex: 0, clientName: facts.clientName,
        title: facts.title, amountCents: facts.amountCents, stage: 'proposal_sent',
        sentAt: facts.sentAt, contactEmail: facts.contactEmail, scoreCents: 0,
        expectedValueCents: 0, pReply: 0, pConvert: 0, urgency: 0, factors: [],
        engineVersion: 'n/a', acted: true, opens14d: 0, touchCount: facts.touchCount,
      },
      draft,
      opportunity: facts,
    };
  }
  return { item, draft, opportunity: facts };
}

/** Is the workspace in sandbox? Trial = sandbox, on purpose. */
export async function sandboxState(session: Session): Promise<{ sandbox: boolean; ownerEmail: string }> {
  const res = await withTenant(session.workspaceId, (db) =>
    db.query<{ subscription_status: string; email: string | null }>(
      `select w.subscription_status, u.email
         from workspaces w
         left join users u on u.workspace_id = w.id and u.role = 'owner'
        where w.id = $1::uuid limit 1`,
      [session.workspaceId],
    ),
  );
  const row = res.rows[0];
  return {
    sandbox: row?.subscription_status === 'trialing' || process.env.SANDBOX_MODE !== 'off',
    ownerEmail: row?.email ?? session.email,
  };
}

export function daysFromNow(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * DAY).toISOString();
}

export async function requireSession(): Promise<Session | null> {
  return getSession();
}
