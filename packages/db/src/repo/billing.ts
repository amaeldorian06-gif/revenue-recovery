import type { Db } from '../client.ts';
import { check, type Decision, type EntitlementAction } from '../../../domain/src/entitlements/check.ts';
import { accessFor, type Access, type SubscriptionState, type SubscriptionStatus } from '../../../domain/src/billing/access.ts';
import { TRIAL_DAYS } from '../../../domain/src/billing/access.ts';

const TRIAL_DAYS_NURTURE_EARLY = 3;
const TRIAL_DAYS_NURTURE_LATE = 10;

/**
 * Billing persistence WITHOUT any payment processor: the trial lifecycle, the
 * plan state, the usage metering and the funnel. Payment itself lives in the
 * manual licensing module (repo/licensing.ts) — Stripe has been removed
 * entirely (see RAPPORT_RETRAIT_STRIPE.md); the legacy stripe_* columns and
 * the stripe_events table stay in the schema (non-destructive migrations)
 * but nothing reads or writes them anymore.
 */

// ---------------------------------------------------------------- read side

export interface BillingState extends SubscriptionState {
  plan: 'starter' | 'growth' | 'scale';
}

export async function getBillingState(db: Db, workspaceId: string): Promise<BillingState> {
  const ws = await db.query<{
    plan: BillingState['plan'];
    subscription_status: SubscriptionStatus;
    trial_ends_at: string | null;
    past_due_at: string | null;
    cancel_at_period_end: boolean;
    current_period_end: string | null;
  }>(
    `select plan, subscription_status, trial_ends_at, past_due_at, cancel_at_period_end,
            current_period_end
       from workspaces where id = $1::uuid`,
    [workspaceId],
  );
  if (ws.rows.length === 0) throw new Error(`workspace ${workspaceId} not found`);
  const r = ws.rows[0]!;
  const state: BillingState = {
    plan: r.plan,
    subscriptionStatus: r.subscription_status,
    trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at) : null,
    pastDueAt: r.past_due_at ? new Date(r.past_due_at) : null,
    cancelAtPeriodEnd: r.cancel_at_period_end,
    currentPeriodEnd: r.current_period_end ? new Date(r.current_period_end) : null,
  };
  return state;
}

export async function getAccess(db: Db, workspaceId: string, now: Date = new Date()): Promise<Access> {
  const s = await getBillingState(db, workspaceId);
  return accessFor(s, now);
}

// ---------------------------------------------------------------- metering

export interface Usage {
  proposalsTracked: number;
  emailsSent: number;
  seats: number;
  mailboxes: number;
}

function periodStart(now: Date = new Date()): string {
  // Billing periods align on the calendar month (UTC); a confirmed manual
  // renewal resets the bucket (see confirmPaymentAndActivateSubscription).
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function getUsage(db: Db, workspaceId: string, now: Date = new Date()): Promise<Usage> {
  const start = periodStart(now);
  await db.query(
    `insert into usage_counters (workspace_id, period_start) values ($1::uuid, $2)
     on conflict (workspace_id, period_start) do nothing`,
    [workspaceId, start],
  );
  const res = await db.query<{
    proposals_tracked: number; emails_sent: number; seats: number; mailboxes: number;
  }>(
    `select u.proposals_tracked, u.emails_sent,
            (select count(*)::int from users us where us.workspace_id = w.id) as seats,
            (select count(*)::int from mailbox_connections mc
              where mc.workspace_id = w.id and mc.status <> 'disconnected'
                and mc.provider <> 'sandbox') as mailboxes
       from workspaces w
       join usage_counters u on u.workspace_id = w.id and u.period_start = $2
      where w.id = $1::uuid`,
    [workspaceId, start],
  );
  const r = res.rows[0]!;
  return {
    proposalsTracked: r.proposals_tracked,
    emailsSent: r.emails_sent,
    seats: r.seats,
    mailboxes: r.mailboxes,
  };
}

export async function resetUsage(db: Db, workspaceId: string, now: Date = new Date()): Promise<void> {
  // A new period starts empty: `invoice.paid` zeroes the current bucket. The
  // counter is the live meter, not history — nothing carries a debt forward.
  await db.query(
    `insert into usage_counters (workspace_id, period_start) values ($1::uuid, $2)
     on conflict (workspace_id, period_start) do update
       set proposals_tracked = 0, emails_sent = 0, updated_at = now()`,
    [workspaceId, periodStart(now)],
  );
}

/**
 * The single door every enforcement point walks through. The plan is read from
 * the database *here*, per request — never from the client, never cached
 * beyond the request (phase trap).
 */
export async function assertEntitlement(
  db: Db,
  workspaceId: string,
  action: EntitlementAction,
  opts: { incoming?: number; requestedHoldoutRate?: number } = {},
  now: Date = new Date(),
): Promise<{ decision: Decision; access: Access; usage: Usage }> {
  const state = await getBillingState(db, workspaceId);
  const usage = await getUsage(db, workspaceId, now);
  const decision = check(state.plan, usage, action, opts);
  const access = accessFor(state, now);
  if (!decision.allowed) {
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'entitlement.refused', 'workspace', $1::text, $2::jsonb)`,
      [workspaceId, JSON.stringify({ action, reason: decision.reasonCode, usage })],
    );
  }
  return { decision, access, usage };
}

// ---------------------------------------------------------------- funnel

export async function recordFunnel(
  db: Db, workspaceId: string, userId: string | null, name: string,
): Promise<boolean> {
  const res = await db.query<{ id: string }>(
    `insert into funnel_events (workspace_id, user_id, name)
     values ($1::uuid, $2::uuid, $3)
     on conflict (workspace_id, name) do nothing
     returning id`,
    [workspaceId, userId, name],
  );
  return res.rows.length > 0;
}

export interface FunnelStep {
  name: string;
  count: number;
  medianMinutes: number | null;
}

export const FUNNEL_STEPS = [
  'signup_completed',
  'mailbox_step_done',
  'import_confirmed',
  'calibration_seen',
  'queue_generated',
] as const;

export async function funnelSummary(db: Db): Promise<FunnelStep[]> {
  const names = FUNNEL_STEPS;
  const res = await db.query<{ name: string; count: number }>(
    `select name, count(*)::int as count from funnel_events where name = any($1::text[]) group by name`,
    [[...names]],
  );
  const counts = new Map(res.rows.map((r) => [r.name, r.count]));

  const med = await db.query<{ minutes: number | null }>(
    `select percentile_cont(0.5) within group (
       order by extract(epoch from (q.created_at - s.created_at)) / 60.0) as minutes
       from funnel_events s
       join funnel_events q on q.workspace_id = s.workspace_id and q.name = 'queue_generated'
      where s.name = 'signup_completed'`,
  );
  const median = med.rows[0]?.minutes ?? null;

  return names.map((name) => ({
    name,
    count: counts.get(name) ?? 0,
    medianMinutes: name === 'queue_generated' ? (median === null ? null : Math.round(median * 10) / 10) : null,
  }));
}

// ---------------------------------------------------------------- trial job

export interface TrialJobResult {
  day3: number;
  day10: number;
  expired: number;
}

/**
 * The trial job. Day 3 and day 10 emails report what was detected, acted on
 * and what remains — never "your trial is ending" pressure copy. Expiry is
 * recorded once as a funnel event; the freeze itself is computed by
 * `accessFor` from the dates, so no state has to be rewritten.
 */
export async function runTrialJob(
  db: Db,
  sendEmail: (workspaceId: string, ownerEmail: string, kind: 'day3' | 'day10') => Promise<void>,
  now: Date = new Date(),
): Promise<TrialJobResult> {
  const rows = await db.query<{
    id: string; owner_email: string | null; days_left: number;
  }>(
    `select w.id, u.email as owner_email,
            ceil(extract(epoch from (w.trial_ends_at - now())) / 86400.0)::int as days_left
       from workspaces w
       left join users u on u.workspace_id = w.id and u.role = 'owner'
      where w.subscription_status = 'trialing' and w.deleted_at is null
        and w.trial_ends_at is not null`,
  );

  let day3 = 0;
  let day10 = 0;
  let expired = 0;
  for (const r of rows.rows) {
    const days = r.days_left;
    if (days <= 0) {
      if (await recordFunnel(db, r.id, null, 'trial_expired')) expired += 1;
      continue;
    }
    const daysElapsed = TRIAL_DAYS - days;
    // Idempotence comes from `recordFunnel`: the first run after day 3 sends
    // the day-3 email, even if the cron missed the exact day.
    if (daysElapsed >= TRIAL_DAYS_NURTURE_LATE && (await recordFunnel(db, r.id, null, 'trial_day10_email'))) {
      await sendEmail(r.id, r.owner_email ?? '', 'day10');
      day10 += 1;
    } else if (daysElapsed >= TRIAL_DAYS_NURTURE_EARLY && (await recordFunnel(db, r.id, null, 'trial_day3_email'))) {
      await sendEmail(r.id, r.owner_email ?? '', 'day3');
      day3 += 1;
    }
  }
  return { day3, day10, expired };
}
