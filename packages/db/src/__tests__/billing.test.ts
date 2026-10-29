/**
 * Billing persistence AFTER the Stripe removal (RAPPORT_RETRAIT_STRIPE.md):
 * the trial lifecycle, the usage metering, the plan limits and the trial job.
 * Payment activation now lives in repo/licensing.ts (manual confirmation);
 * these tests set the workspace state directly with SQL — exactly what the
 * removed webhook used to do through Stripe events.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { getBillingState, getUsage, assertEntitlement, getAccess, runTrialJob, resetUsage } from '../repo/billing.ts';
import { accessFor } from '../../../domain/src/billing/access.ts';

let db: Db;
let workspaceId: string;
let userId: string;

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-26T10:00:00Z');

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const created = await createWorkspaceWithOwner(db, {
    email: 'facture@cabinet-aubert.fr', workspaceName: 'Cabinet Aubert', locale: 'fr',
  });
  workspaceId = created.workspaceId;
  userId = created.userId;
});

describe('trial state — read side (no processor involved)', () => {
  it('a fresh workspace is trialing for 14 days with no customer record at all', async () => {
    const state = await getBillingState(db, workspaceId);
    expect(state.subscriptionStatus).toBe('trialing');
    expect(state).not.toHaveProperty('stripeCustomerId');
    const days = (state.trialEndsAt!.getTime() - Date.now()) / DAY;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);

    const access = accessFor(state, NOW);
    expect(access.canSend).toBe(true);
    expect(access.sandbox).toBe(true);
  });

  it('cancelling the trial is a pure status write: nothing can be charged', async () => {
    await db.query(`update workspaces set subscription_status = 'canceled' where id = $1::uuid`, [workspaceId]);
    const state = await getBillingState(db, workspaceId);
    const access = await getAccess(db, workspaceId, NOW);
    expect(access.canSend).toBe(false);
    expect(access.readOnly).toBe(true);
    expect(access.canExport).toBe(true);
    expect(state.subscriptionStatus).toBe('canceled');
  });
});

describe('plan limits — downgrade Scale → Starter with 250 proposals', () => {
  beforeEach(async () => {
    await db.query(`update workspaces set plan = 'starter' where id = $1::uuid`, [workspaceId]);
    await resetUsage(db, workspaceId, NOW);
    await db.query(
      `update usage_counters set proposals_tracked = 250 where workspace_id = $1::uuid`,
      [workspaceId],
    );
  });

  it('no data is deleted — the 250 dossiers are all still there', async () => {
    for (let i = 0; i < 250; i += 1) {
      await db.query(
        `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, source)
         values ($1::uuid, $2, $3, 500000, now() - interval '5 days', 'open', 'treatment', 'import')
         on conflict do nothing`,
        [workspaceId, `dsg-${i}`, `Client ${i}`],
      );
    }
    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities where workspace_id = $1::uuid', [workspaceId]);
    expect(n.rows[0]!.n).toBe(250);
    await db.query(`delete from opportunities where workspace_id = $1::uuid and external_ref like 'dsg-%'`, [workspaceId]);
  });

  it('new imports are blocked with PLAN_LIMIT_EXCEEDED, queues keep working', async () => {
    const { decision } = await assertEntitlement(db, workspaceId, 'import_proposals', { incoming: 10 }, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('PLAN_LIMIT_EXCEEDED');
    // The refusal left a trace an operator can audit.
    const audits = await db.query<{ n: number }>(
      `select count(*)::int as n from audit_log where workspace_id = $1::uuid and action = 'entitlement.refused'`,
      [workspaceId],
    );
    expect(audits.rows[0]!.n).toBe(1);
    // Reading the queue is a different entitlement door — nothing blocks it.
    const state = await getBillingState(db, workspaceId);
    expect(accessFor(state, NOW).readOnly).toBe(false);
  });

  it('the UI finds the overage to explain: usage above the Starter ceiling', async () => {
    const usage = await getUsage(db, workspaceId, NOW);
    expect(usage.proposalsTracked).toBe(250);
  });
});

describe('past_due — paused now, frozen after 3 days (state written directly)', () => {
  it('day 1: sending paused, workspace still writable', async () => {
    await db.query(
      `update workspaces set subscription_status = 'past_due', past_due_at = $2::timestamptz where id = $1::uuid`,
      [workspaceId, new Date(NOW.getTime() - 1 * DAY).toISOString()],
    );
    const access = await getAccess(db, workspaceId, NOW);
    expect(access.canSend).toBe(false);
    expect(access.readOnly).toBe(false);
    expect(access.banner).toEqual({ kind: 'past_due' });
  });

  it('day 4: read-only, export kept', async () => {
    await db.query(
      `update workspaces set subscription_status = 'past_due', past_due_at = $2::timestamptz where id = $1::uuid`,
      [workspaceId, new Date(NOW.getTime() - 4 * DAY).toISOString()],
    );
    const access = await getAccess(db, workspaceId, NOW);
    expect(access.canSend).toBe(false);
    expect(access.readOnly).toBe(true);
    expect(access.canExport).toBe(true);
  });

  it('returning to active with a fresh period lifts everything and zeroes the meter', async () => {
    await db.query(
      `update workspaces set subscription_status = 'past_due', past_due_at = now() - interval '2 days' where id = $1::uuid`,
      [workspaceId],
    );
    await db.query(
      `insert into usage_counters (workspace_id, period_start, proposals_tracked) values ($1::uuid, '2026-10-01', 40)`,
      [workspaceId],
    );
    // What the licensing confirmation now does on a confirmed payment:
    await db.query(`update workspaces set subscription_status = 'active', past_due_at = null, current_period_end = $2::timestamptz where id = $1::uuid`,
      [workspaceId, new Date(NOW.getTime() + 30 * DAY).toISOString()]);
    await resetUsage(db, workspaceId, NOW);
    const state = await getBillingState(db, workspaceId);
    expect(state.subscriptionStatus).toBe('active');
    const access = await getAccess(db, workspaceId, NOW);
    expect(access.canSend).toBe(true);
    expect(access.readOnly).toBe(false);
    // The new period starts empty — the counter never carries a debt.
    const usage = await getUsage(db, workspaceId, NOW);
    expect(usage.proposalsTracked).toBe(0);
  });
});

describe('trial expiry', () => {
  it('expired trial: sending blocked, read-only, data kept', async () => {
    await db.query(
      `update workspaces set trial_ends_at = $2::timestamptz where id = $1::uuid`,
      [workspaceId, new Date(NOW.getTime() - 1 * DAY).toISOString()],
    );
    const access = await getAccess(db, workspaceId, NOW);
    expect(access.canSend).toBe(false);
    expect(access.readOnly).toBe(true);
    expect(access.canExport).toBe(true);
    expect(access.banner).toEqual({ kind: 'trial_expired' });

    const n = await db.query<{ n: number }>('select count(*)::int as n from opportunities where workspace_id = $1::uuid', [workspaceId]);
    expect(n.rows[0]!.n).toBe(0); // nothing deleted — the count starts at zero here
  });

  it('runTrialJob records trial_expired exactly once', async () => {
    await db.query(
      `update workspaces set trial_ends_at = now() - interval '1 day' where id = $1::uuid`,
      [workspaceId],
    );
    const first = await runTrialJob(db, async () => {}, NOW);
    expect(first.expired).toBe(1);
    const second = await runTrialJob(db, async () => {}, NOW);
    expect(second.expired).toBe(0);
  });

  it('day-3 email fires on the first run past day 3, never twice', async () => {
    await db.query(
      `update workspaces set trial_ends_at = now() + interval '11 days' where id = $1::uuid`,
      [workspaceId],
    );
    const sent: string[] = [];
    const first = await runTrialJob(db, async (_ws, _email, kind) => { sent.push(kind); }, NOW);
    expect(first.day3).toBe(1);
    expect(sent).toEqual(['day3']);
    const second = await runTrialJob(db, async () => {}, NOW);
    expect(second.day3).toBe(0);
  });

  it('day-10 email takes precedence once day 10 is crossed', async () => {
    await db.query(
      `update workspaces set trial_ends_at = now() + interval '3 days' where id = $1::uuid`,
      [workspaceId],
    );
    const sent: string[] = [];
    await runTrialJob(db, async (_ws, _email, kind) => { sent.push(kind); }, NOW);
    expect(sent).toEqual(['day10']);
  });
});

describe('metering — usage counters and the mailbox/seat counts', () => {
  it('counts seats and non-sandbox mailboxes from the database', async () => {
    await db.query(
      `insert into mailbox_connections (workspace_id, provider) values ($1::uuid, 'gmail_oauth')`,
      [workspaceId],
    );
    const usage = await getUsage(db, workspaceId, NOW);
    expect(usage.seats).toBe(1);
    expect(usage.mailboxes).toBe(1);

    await db.query(
      `insert into mailbox_connections (workspace_id, provider) values ($1::uuid, 'sandbox')`,
      [workspaceId],
    );
    const again = await getUsage(db, workspaceId, NOW);
    expect(again.mailboxes).toBe(1); // the sandbox pseudo-connection never counts
  });

  it('connect_mailbox refuses the second mailbox on Growth', async () => {
    await db.query(`update workspaces set plan = 'growth' where id = $1::uuid`, [workspaceId]);
    await db.query(
      `insert into mailbox_connections (workspace_id, provider) values ($1::uuid, 'gmail_oauth'), ($1::uuid, 'smtp_imap')`,
      [workspaceId],
    );
    const { decision } = await assertEntitlement(db, workspaceId, 'connect_mailbox', {}, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('PLAN_LIMIT_EXCEEDED');
  });
});
