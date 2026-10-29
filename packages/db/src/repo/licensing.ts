/**
 * Monthly licensing, manual confirmation. THE single authority on paid access.
 *
 * Flow: customer submits a payment declaration → pending row; the platform
 * administrator verifies actual receipt (bank / Chariow / Maketou records) and
 * confirms — one transaction marks the payment confirmed and activates or
 * extends the subscription by one CALENDAR month. Entitlement is computed here,
 * from the database, at every check: a stored `active` status alone proves
 * nothing once the expiry has passed.
 *
 * No Stripe, no aggregator, no card processing. The Chariow/Maketou channels
 * are display-only instructions plus a reference the customer types in; their
 * real capabilities were not verified, so nothing is automated against them.
 */
import { withExclusive, type Db } from '../client.ts';
import { resetUsage } from './billing.ts';
import { PLANS, type Plan } from '../../../domain/src/entitlements/check.ts';

export const PRODUCT_ID = 'revenue_recovery_os';

/** XAF is pegged to the euro at exactly 655.957 — no rate service needed. */
export const XAF_PER_EUR = 655.957;

export type SubscriptionStatus = 'pending' | 'active' | 'expired' | 'suspended' | 'cancelled';
export type PaymentMethod = 'bank_transfer' | 'chariow' | 'maketou';

export interface Entitlement {
  accessAllowed: boolean;
  status: SubscriptionStatus | 'none' | 'trial';
  productId: string;
  expiresAt: string | null;
  reasonCode:
    | 'trial_active'
    | 'subscription_active'
    | 'no_subscription'
    | 'pending'
    | 'expired'
    | 'suspended'
    | 'cancelled'
    | 'not_started'
    | 'product_disabled';
}

/** The expected price of a plan, in the payment's minor units. */
export function expectedAmountCents(plan: Plan, currency: 'EUR' | 'XAF'): number {
  const eur = PLANS[plan].priceMonthlyEur;
  if (currency === 'EUR') return eur * 100;
  // XAF has no subunit in practice: minor unit = franc.
  return Math.round(eur * XAF_PER_EUR);
}

/**
 * Is the workspace entitled right now? Computed, not trusted: `active` with a
 * past expiry is `expired`, `expired` with a future expiry (an admin data fix)
 * is still denied until the status is corrected — the period and the status
 * must BOTH hold, plus the product must be enabled.
 */
export async function getCurrentEntitlement(db: Db, workspaceId: string, now: Date): Promise<Entitlement> {
  const r = await db.query<{
    status: SubscriptionStatus | null;
    starts_at: string | null;
    expires_at: string | null;
    product_enabled: boolean | null;
    // Existing behaviour kept intact: a workspace in its trial keeps working.
    subscription_status: string | null;
    trial_ends_at: string | null;
  }>(
    `select s.status, s.starts_at::text, s.expires_at::text, p.enabled as product_enabled,
            w.subscription_status::text, w.trial_ends_at::text
       from workspaces w
       left join subscriptions s on s.workspace_id = w.id and s.product_id = $2::text
       left join products p on p.id = $2::text
      where w.id = $1::uuid`,
    [workspaceId, PRODUCT_ID],
  );
  const row = r.rows[0];
  if (!row) return denied('no_subscription', null);

  // Trial: the pre-existing funnel stays functional (phases 01–08 keep passing).
  if (
    row.status === null
    && row.subscription_status === 'trialing'
    && row.trial_ends_at !== null
    && new Date(row.trial_ends_at).getTime() > now.getTime()
  ) {
    return { accessAllowed: true, status: 'trial', productId: PRODUCT_ID, expiresAt: row.trial_ends_at, reasonCode: 'trial_active' };
  }

  if (row.status === null) return denied('no_subscription', null);
  if (row.product_enabled === false) return denied('product_disabled', row.expires_at);
  if (row.status === 'pending') return denied('pending', row.expires_at);
  if (row.status === 'suspended') return denied('suspended', row.expires_at);
  if (row.status === 'cancelled') return denied('cancelled', row.expires_at);

  // Status says active: the period must hold too — never the status alone.
  if (row.status === 'active') {
    const startsAt = row.starts_at ? new Date(row.starts_at).getTime() : null;
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;
    if (startsAt === null || expiresAt === null) return denied('expired', row.expires_at);
    if (startsAt > now.getTime()) return denied('not_started', row.expires_at);
    if (expiresAt <= now.getTime()) {
      // Lazily record the transition once — expiry processing is auditable.
      await markExpired(db, workspaceId, now);
      return denied('expired', row.expires_at);
    }
    return { accessAllowed: true, status: 'active', productId: PRODUCT_ID, expiresAt: row.expires_at, reasonCode: 'subscription_active' };
  }

  return denied('expired', row.expires_at);
}

function denied(reasonCode: Entitlement['reasonCode'], expiresAt: string | null): Entitlement {
  return { accessAllowed: false, status: reasonCode === 'no_subscription' ? 'none' : (reasonCode as SubscriptionStatus), productId: PRODUCT_ID, expiresAt, reasonCode };
}

async function markExpired(db: Db, workspaceId: string, now: Date): Promise<void> {
  const upd = await db.query<{ id: string }>(
    `update subscriptions set status = 'expired', updated_at = $2::timestamptz
      where workspace_id = $1::uuid and product_id = $3::text
        and status = 'active' and expires_at <= $2::timestamptz
      returning id`,
    [workspaceId, now.toISOString(), PRODUCT_ID],
  );
  if (upd.rows[0]) {
    await db.query(
      `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
       values ($1::uuid, 'system', 'subscription.expired', 'subscription', $2, $3::jsonb)`,
      [workspaceId, upd.rows[0].id, JSON.stringify({ product: PRODUCT_ID, at: now.toISOString() })],
    );
  }
}

// ---------------------------------------------------------------- confirmation

export interface ConfirmInput {
  paymentId: string;
  adminUserId: string;
  now: Date;
}

export interface ConfirmOutcome {
  ok: boolean;
  code:
    | 'confirmed_extended'
    | 'confirmed_activated'
    | 'already_confirmed'
    | 'already_used'
    | 'not_pending'
    | 'not_found'
    | 'amount_mismatch'
    | 'currency_mismatch'
    | 'product_mismatch'
    | 'subscription_missing';
  subscriptionId?: string;
  expiresAt?: string;
  /** Info-only details; never financial evidence, just the decision trail. */
  detail?: string;
}

/**
 * THE transaction: verify receipt metadata, mark the payment confirmed,
 * activate or extend the subscription by one calendar month, flip the
 * workspace's subscription state, audit every step, commit once.
 *
 * Idempotent by row state, not by frontend discipline: `for update` +
 * `status = 'pending'` mean a double click or two racing admins produce
 * exactly one month, and the loser gets `already_confirmed`.
 */
export async function confirmPaymentAndActivateSubscription(db: Db, input: ConfirmInput): Promise<ConfirmOutcome> {
  return withExclusive(async () => {
  await db.exec('begin');
  try {
    const pay = await db.query<{
      id: string; workspace_id: string; subscription_id: string; plan: Plan;
      amount_cents: string; currency: 'EUR' | 'XAF'; status: string; external_reference: string | null;
    }>(
      `select id, workspace_id, subscription_id, plan::text as plan, amount_cents::text as amount_cents,
              currency::text as currency, status, external_reference
         from payments where id = $1::uuid for update`,
      [input.paymentId],
    );
    const p = pay.rows[0];
    if (!p) {
      await db.exec('rollback');
      return { ok: false, code: 'not_found' };
    }
    if (p.status === 'confirmed') {
      await db.exec('rollback');
      return { ok: false, code: 'already_confirmed' };
    }
    if (p.status !== 'pending') {
      await db.exec('rollback');
      return { ok: false, code: 'not_pending' };
    }

    // Amount and currency must match the plan exactly (XAF pegged at 655.957).
    // A mismatch is a rejected payment, not a negotiation at confirm time.
    const expected = expectedAmountCents(p.plan, p.currency);
    const received = Number(p.amount_cents);
    if (received !== expected) {
      const reason = 'amount_mismatch';
      await db.query(
        `update payments set status = 'rejected', rejection_reason = $2,
                validated_by = $3::uuid, validated_at = $4::timestamptz where id = $1::uuid`,
        [p.id, reason, input.adminUserId, input.now.toISOString()],
      );
      await db.query(
        `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
         values ($1::uuid, 'user', $2::uuid, 'payment.rejected', 'payment', $3, $4::jsonb)`,
        [p.workspace_id, input.adminUserId, p.id, JSON.stringify({ reason, expected, received })],
      );
      await db.exec('commit');
      return { ok: false, code: 'amount_mismatch', detail: `expected ${expected} ${p.currency}, received ${received}` };
    }

    // The subscription must belong to THIS workspace and THIS product: an admin
    // can only ever confirm what the tenant's own declaration points at.
    const sub = await db.query<{ id: string; status: SubscriptionStatus; starts_at: string | null; expires_at: string | null }>(
      `select id, status::text as status, starts_at::text, expires_at::text
         from subscriptions
        where id = $1::uuid and workspace_id = $2::uuid and product_id = $3::text for update`,
      [p.subscription_id, p.workspace_id, PRODUCT_ID],
    );
    const s = sub.rows[0];
    if (!s) {
      await db.exec('rollback');
      return { ok: false, code: 'subscription_missing' };
    }

    // Calendar-month extension: valid & active extends from its own expiry
    // (banking arithmetic: Jan 31 + 1 month = Feb 28); anything else starts now.
    const wasActive = s.status === 'active' && s.expires_at !== null
      && new Date(s.expires_at).getTime() > input.now.getTime();
    const baseIso = wasActive ? (s.expires_at as string) : input.now.toISOString();
    const newExpiry = await db.query<{ expires_at: string }>(
      `select ($1::timestamptz + interval '1 month')::text as expires_at`,
      [baseIso],
    );
    const expiresAt = newExpiry.rows[0]!.expires_at;

    await db.query(
      `update payments set status = 'confirmed', validated_by = $2::uuid, validated_at = $3::timestamptz
        where id = $1::uuid`,
      [p.id, input.adminUserId, input.now.toISOString()],
    );
    await db.query(
      `update subscriptions
          set status = 'active',
              starts_at = coalesce(starts_at, $2::timestamptz),
              expires_at = $3::timestamptz,
              updated_at = $2::timestamptz
        where id = $1::uuid`,
      [s.id, input.now.toISOString(), expiresAt],
    );
    await db.query(
      `update workspaces set subscription_status = 'active' where id = $1::uuid`,
      [p.workspace_id],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, $3, 'subscription', $4::uuid, $5::jsonb)`,
      [
        p.workspace_id, input.adminUserId,
        wasActive ? 'subscription.renewed' : 'subscription.activated',
        s.id,
        JSON.stringify({ payment: p.id, plan: p.plan, from: baseIso, expires_at: expiresAt }),
      ],
    );
    // The paid month starts with a clean meter — a counter never carries a
    // debt across a confirmed renewal (semantic inherited from the removed
    // Stripe invoice.paid handler).
    await resetUsage(db, p.workspace_id, new Date(baseIso));
    await db.exec('commit');
    return {
      ok: true,
      code: wasActive ? 'confirmed_extended' : 'confirmed_activated',
      subscriptionId: s.id,
      expiresAt,
    };
  } catch (err) {
    // A failure anywhere rolls the whole confirmation back — no half-activated
    // subscription, no confirmed payment pointing at an unextended period.
    await db.exec('rollback').catch(() => {});
    throw err;
  }
  });
}

/** Explicit authorized suspension — never automatic, never implicit. */
export async function suspendSubscription(db: Db, workspaceId: string, adminUserId: string, now: Date): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    `update subscriptions set status = 'suspended', updated_at = $3::timestamptz
      where workspace_id = $1::uuid and product_id = $2::text and status = 'active'
      returning id`,
    [workspaceId, PRODUCT_ID, now.toISOString()],
  );
  if (!r.rows[0]) return false;
  await db.query(
    `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
     values ($1::uuid, 'user', $2::uuid, 'subscription.suspended', 'subscription', $3::uuid, $4::jsonb)`,
    [workspaceId, adminUserId, r.rows[0].id, JSON.stringify({ product: PRODUCT_ID })],
  );
  return true;
}

/** Reactivation is an explicit authorized decision, never a side effect. */
export async function reactivateSubscription(db: Db, workspaceId: string, adminUserId: string, now: Date, extendMonths = 0): Promise<string | null> {
  const r = await db.query<{ id: string; expires_at: string | null }>(
    `update subscriptions set status = 'active', updated_at = $3::timestamptz,
            expires_at = case when $4::int > 0
                              then coalesce(expires_at, $3::timestamptz) + ($4::int || ' months')::interval
                              else expires_at end
      where workspace_id = $1::uuid and product_id = $2::text and status = 'suspended'
      returning id, expires_at::text`,
    [workspaceId, PRODUCT_ID, now.toISOString(), extendMonths],
  );
  if (!r.rows[0]) return null;
  await db.query(
    `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
     values ($1::uuid, 'user', $2::uuid, 'subscription.reactivated', 'subscription', $3::uuid, $4::jsonb)`,
    [workspaceId, adminUserId, r.rows[0].id, JSON.stringify({ product: PRODUCT_ID, extendMonths })],
  );
  return r.rows[0].id;
}

/** Customer declaration: a pending row, nothing else. Proof comes from money. */
export async function submitPaymentDeclaration(
  db: Db,
  input: {
    workspaceId: string; userId: string; plan: Plan; amountCents: number;
    currency: 'EUR' | 'XAF'; method: PaymentMethod; externalReference: string | null; now: Date;
  },
): Promise<{ ok: true; paymentId: string; subscriptionId: string } | { ok: false; code: 'bad_amount' | 'duplicate_reference' | 'no_subscription' }> {
  if (input.amountCents <= 0) return { ok: false, code: 'bad_amount' };
  return withExclusive(async () => {
  const sub = await db.query<{ id: string }>(
    `select id from subscriptions where workspace_id = $1::uuid and product_id = $2::text`,
    [input.workspaceId, PRODUCT_ID],
  );
  let subscriptionId = sub.rows[0]?.id;
  if (!subscriptionId) {
    // First declaration creates the pending entitlement row.
    const created = await db.query<{ id: string }>(
      `insert into subscriptions (workspace_id, product_id, status) values ($1::uuid, $2::text, 'pending') returning id`,
      [input.workspaceId, PRODUCT_ID],
    );
    subscriptionId = created.rows[0]!.id;
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'subscription.requested', 'subscription', $3::uuid, $4::jsonb)`,
      [input.workspaceId, input.userId, subscriptionId, JSON.stringify({ product: PRODUCT_ID })],
    );
  }
  try {
    const r = await db.query<{ id: string }>(
      `insert into payments (workspace_id, subscription_id, plan, amount_cents, currency,
                             payment_method, external_reference, submitted_by)
       values ($1::uuid, $2::uuid, $3::text, $4::bigint, $5::text, $6::text, $7::text, $8::uuid)
       returning id`,
      [input.workspaceId, subscriptionId, input.plan, input.amountCents, input.currency,
       input.method, input.externalReference, input.userId],
    );
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'payment.submitted', 'payment', $3, $4::jsonb)`,
      [input.workspaceId, input.userId, r.rows[0]!.id,
       JSON.stringify({ plan: input.plan, method: input.method, currency: input.currency, amount_cents: input.amountCents, reference: input.externalReference })],
    );
    return { ok: true, paymentId: r.rows[0]!.id, subscriptionId };
  } catch (err) {
    // The unique partial index on (method, reference) speaks here: one bank
    // slip, one declaration. A duplicate gets its own clear error, not a 500.
    const message = err instanceof Error ? err.message : '';
    if (message.includes('payments_external_ref_unique')) return { ok: false, code: 'duplicate_reference' };
    throw err;
  }
  });
}
