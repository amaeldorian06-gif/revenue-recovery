/**
 * Licensing (migration 0009) — the manual-payment subscription model, tested
 * the way §12 demands: against the real database, including the grants (a
 * customer CANNOT flip a status or extend an expiry, even by direct SQL with
 * the app role), the calendar-month arithmetic, the idempotent confirmation
 * and the expiry boundary `now >= expires_at`.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, asWorkspace, asSuperuser, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  getCurrentEntitlement, confirmPaymentAndActivateSubscription, submitPaymentDeclaration,
  suspendSubscription, reactivateSubscription, expectedAmountCents, PRODUCT_ID,
} from '../repo/licensing.ts';

const NOW = new Date('2026-10-28T09:00:00Z');
let db: Db;
let ws: string;
let userId: string;

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const a = await createWorkspaceWithOwner(db, {
    email: 'lic@agence.fr', workspaceName: 'Agence Lic', locale: 'fr',
  });
  ws = a.workspaceId;
  userId = a.userId;
});

/** Seed a pending declaration (the customer path) and return its id. */
async function declare(plan: 'starter' | 'growth' | 'scale' = 'growth', opts?: {
  currency?: 'EUR' | 'XAF'; amount?: number; reference?: string | null;
}): Promise<string> {
  const currency = opts?.currency ?? 'EUR';
  const amount = opts?.amount ?? expectedAmountCents(plan, currency);
  const r = await submitPaymentDeclaration(db, {
    workspaceId: ws, userId, plan, amountCents: amount, currency,
    method: 'bank_transfer', externalReference: opts?.reference ?? `TR-${crypto.randomUUID().slice(0, 8)}`,
    now: NOW,
  });
  if (!r.ok) throw new Error(r.code);
  return r.paymentId;
}

async function confirm(paymentId: string, at: Date = NOW) {
  return confirmPaymentAndActivateSubscription(db, { paymentId, adminUserId: userId, now: at });
}

async function setStatus(status: string, expiresAt: string | null = null): Promise<void> {
  await asSuperuser(db, async () => {
    await db.query(
      `update subscriptions set status = $2::text,
              starts_at = coalesce(starts_at, $3::timestamptz),
              expires_at = coalesce(expires_at, $4::timestamptz)
        where workspace_id = $1::uuid and product_id = $5::text`,
      [ws, status, NOW.toISOString(), expiresAt ?? NOW.toISOString(), PRODUCT_ID],
    );
  });
}

describe('entitlement validity — the status alone never decides', () => {
  it('no declaration → no_subscription, denied (once the trial is over)', async () => {
    // A fresh workspace sits in its 14-day trial — that funnel behaviour is
    // kept intact. The licensing answer for a workspace OUTSIDE its trial:
    await asSuperuser(db, async () => {
      await db.query(`update workspaces set subscription_status = 'canceled' where id = $1::uuid`, [ws]);
    });
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    expect(e.reasonCode).toBe('no_subscription');
  });

  it('an active trial keeps the product usable (existing funnel behaviour preserved)', async () => {
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(true);
    expect(e.status).toBe('trial');
  });

  it('pending declaration → denied until an admin confirms', async () => {
    await declare();
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    expect(e.reasonCode).toBe('pending');
  });

  it('active within the period → allowed', async () => {
    await declare();
    await confirm(await declare());
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(true);
    expect(e.status).toBe('active');
  });

  it('active but expiry passed → denied expired, and the flip is recorded', async () => {
    await declare();
    await confirm(await declare(), new Date('2026-09-01T09:00:00Z'));
    // Force a period that ended yesterday while keeping status='active':
    // exactly the row a dishonest client would love to trust.
    await asSuperuser(db, async () => {
      await db.query(
        `update subscriptions set expires_at = $2::timestamptz where workspace_id = $1::uuid and product_id = $3::text`,
        [ws, new Date(NOW.getTime() - 86_400_000).toISOString(), PRODUCT_ID],
      );
    });
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    expect(e.reasonCode).toBe('expired');
    const audit = await db.query<{ n: string }>(
      `select count(*)::text as n from audit_log where action = 'subscription.expired'`,
    );
    expect(Number(audit.rows[0]!.n)).toBeGreaterThanOrEqual(1);
  });

  it('not started → denied', async () => {
    await declare();
    await confirm(await declare(), NOW);
    await asSuperuser(db, async () => {
      await db.query(
        `update subscriptions set starts_at = $2::timestamptz where workspace_id = $1::uuid and product_id = $3::text`,
        [ws, new Date(NOW.getTime() + 86_400_000).toISOString(), PRODUCT_ID],
      );
    });
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    expect(e.reasonCode).toBe('not_started');
  });

  it('suspended → denied, even with a live period', async () => {
    await declare();
    await confirm(await declare(), NOW);
    await suspendSubscription(db, ws, userId, NOW);
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    expect(e.reasonCode).toBe('suspended');
    // Reactivation is explicit, and carries no free month unless decided.
    await reactivateSubscription(db, ws, userId, NOW, 0);
    const e2 = await getCurrentEntitlement(db, ws, NOW);
    expect(e2.accessAllowed).toBe(true);
  });

  it('cancelled → denied', async () => {
    await declare();
    await setStatus('cancelled', NOW.toISOString());
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.reasonCode).toBe('cancelled');
  });

  it('wrong product → the row simply does not match', async () => {
    await asSuperuser(db, async () => {
      await db.query(`update workspaces set subscription_status = 'canceled' where id = $1::uuid`, [ws]);
    });
    await asSuperuser(db, async () => {
      await db.query(`insert into products (id, name) values ('another_saas', 'Another SaaS') on conflict do nothing`);
      await db.query(
        `insert into subscriptions (workspace_id, product_id, status, starts_at, expires_at)
         values ($1::uuid, 'another_saas', 'active', $2::timestamptz, $3::timestamptz)`,
        [ws, NOW.toISOString(), new Date(NOW.getTime() + 30 * 86_400_000).toISOString()],
      );
    });
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.reasonCode).toBe('no_subscription');
  });

  it('product disabled by the operator → denied despite an active subscription', async () => {
    await declare();
    await confirm(await declare(), NOW);
    await asSuperuser(db, async () => {
      await db.query(`update products set enabled = false where id = $1::text`, [PRODUCT_ID]);
    });
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    expect(e.reasonCode).toBe('product_disabled');
    // The registry is global state (never truncated): restore for the rest.
    await asSuperuser(db, async () => {
      await db.query(`update products set enabled = true where id = $1::text`, [PRODUCT_ID]);
    });
  });

  it('boundary: now == expires_at is expired (<=, never an implicit grace day)', async () => {
    await declare();
    await confirm(await declare(), NOW);
    await asSuperuser(db, async () => {
      await db.query(
        `update subscriptions set expires_at = $2::timestamptz where workspace_id = $1::uuid and product_id = $3::text`,
        [ws, NOW.toISOString(), PRODUCT_ID],
      );
    });
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    expect(e.reasonCode).toBe('expired');
  });
});

describe('confirmation integrity — money moves once', () => {
  it('extends from expires_at when active (calendar month: Jan 31 → Feb 28)', async () => {
    await declare();
    await confirm(await declare(), new Date('2027-01-31T09:00:00Z'));
    const first = await db.query<{ expires_at: string }>(
      `select expires_at::text from subscriptions where workspace_id = $1::uuid`, [ws],
    );
    expect(first.rows[0]!.expires_at.startsWith('2027-02-28')).toBe(true);
    // A second payment while still active extends FROM THE EXPIRY, not from now.
    await db.query(
      `insert into usage_counters (workspace_id, period_start, proposals_tracked) values ($1::uuid, '2027-02-01', 40)`,
      [ws],
    );
    await confirm(await declare(), new Date('2027-02-10T09:00:00Z'));
    const second = await db.query<{ expires_at: string }>(
      `select expires_at::text from subscriptions where workspace_id = $1::uuid`, [ws],
    );
    expect(second.rows[0]!.expires_at.startsWith('2027-03-28')).toBe(true);
    // The paid month starts with a clean meter (semantic inherited from the
    // removed Stripe invoice.paid handler) — the counter never carries a debt.
    const usage = await db.query<{ n: string }>(
      `select proposals_tracked::text as n from usage_counters where workspace_id = $1::uuid and period_start = '2027-02-01'`,
      [ws],
    );
    expect(Number(usage.rows[0]!.n)).toBe(0);
  });

  it('a duplicate confirmation grants nothing (idempotent by row state)', async () => {
    const pid = await declare();
    const first = await confirm(pid);
    expect(first.ok).toBe(true);
    const again = await confirm(pid);
    expect(again.ok).toBe(false);
    expect(again.code).toBe('already_confirmed');
    const sub = await db.query<{ expires_at: string }>(
      `select expires_at::text from subscriptions where workspace_id = $1::uuid`, [ws],
    );
    expect(sub.rows[0]!.expires_at.startsWith('2026-11-28')).toBe(true);
  });

  it('two concurrent confirmations race on the row lock: exactly one month', async () => {
    const pid = await declare();
    const [a, b] = await Promise.all([
      confirm(pid, new Date(NOW.getTime() + 1000)),
      confirm(pid, new Date(NOW.getTime() + 2000)),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    const sub = await db.query<{ expires_at: string }>(
      `select expires_at::text from subscriptions where workspace_id = $1::uuid`, [ws],
    );
    expect(sub.rows[0]!.expires_at.startsWith('2026-11-28')).toBe(true);
  });

  it('wrong amount → rejected with the reason, no access, audited', async () => {
    const pid = await declare('growth', { amount: 100 });
    const out = await confirm(pid);
    expect(out.ok).toBe(false);
    expect(out.code).toBe('amount_mismatch');
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
    const pay = await db.query<{ status: string; rejection_reason: string | null }>(
      `select status::text, rejection_reason from payments where id = $1::uuid`, [pid],
    );
    expect(pay.rows[0]!.status).toBe('rejected');
    expect(pay.rows[0]!.rejection_reason).toBe('amount_mismatch');
  });

  it('XAF: the fixed peg decides the expected amount (655.957)', () => {
    expect(expectedAmountCents('growth', 'EUR')).toBe(69_900);
    expect(expectedAmountCents('growth', 'XAF')).toBe(Math.round(699 * 655.957));
  });

  it('a duplicate external reference is refused at declaration time', async () => {
    await declare('growth', { reference: 'TR-XYZ-1' });
    const dup = await submitPaymentDeclaration(db, {
      workspaceId: ws, userId, plan: 'growth', amountCents: expectedAmountCents('growth', 'EUR'),
      currency: 'EUR', method: 'bank_transfer', externalReference: 'TR-XYZ-1', now: NOW,
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('duplicate_reference');
  });

  it('a refund does not extend or grant access', async () => {
    const pid = await declare();
    await confirm(pid, NOW);
    await asSuperuser(db, async () => {
      await db.query(`update payments set status = 'refunded' where id = $1::uuid`, [pid]);
    });
    const before = await db.query<{ expires_at: string }>(
      `select expires_at::text from subscriptions where workspace_id = $1::uuid`, [ws],
    );
    // Re-confirming the refunded payment is refused (status no longer pending).
    const again = await confirm(pid);
    expect(again.ok).toBe(false);
    expect(again.code).toBe('not_pending');
    const after = await db.query<{ expires_at: string }>(
      `select expires_at::text from subscriptions where workspace_id = $1::uuid`, [ws],
    );
    expect(after.rows[0]!.expires_at).toBe(before.rows[0]!.expires_at);
  });

  it('a database failure mid-confirmation rolls everything back', async () => {
    const pid = await declare();
    // Break the audit insert (the last writes before commit) by pointing the
    // actor at a deleted user: the payment UPDATE succeeds, the audit fails.
    await asSuperuser(db, async () => {
      await db.query(`insert into users (id, auth_user_id, workspace_id, email, role)
                      values ('11111111-1111-4111-8111-111111111111', 'ghost', $1::uuid, 'ghost@x.fr', 'owner')
                      on conflict do nothing`, [ws]);
      await db.query(`delete from users where id = '11111111-1111-4111-8111-111111111111'`);
    });
    await expect(confirmPaymentAndActivateSubscription(db, {
      paymentId: pid, adminUserId: '11111111-1111-4111-8111-111111111111', now: NOW,
    })).rejects.toThrow();
    // Nothing leaked: still pending, still no access.
    const pay = await db.query<{ status: string }>(`select status::text from payments where id = $1::uuid`, [pid]);
    expect(pay.rows[0]!.status).toBe('pending');
    const e = await getCurrentEntitlement(db, ws, NOW);
    expect(e.accessAllowed).toBe(false);
  });
});

describe('the customer cannot self-serve entitlement — grants, not UI', () => {
  it('the app role cannot update subscriptions at all (status, expiry, owner)', async () => {
    await declare();
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update subscriptions set status = 'active', expires_at = now() + interval '1 year' where workspace_id = $1::uuid`, [ws]);
    })).rejects.toThrow(/permission denied/i);
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update subscriptions set expires_at = now() + interval '10 years'`);
    })).rejects.toThrow(/permission denied/i);
  });

  it('the app role cannot confirm a payment or mark it confirmed', async () => {
    const pid = await declare();
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update payments set status = 'confirmed' where id = $1::uuid`, [pid]);
    })).rejects.toThrow(/permission denied/i);
  });

  it('the app role cannot flip is_platform_admin (column-scoped grant)', async () => {
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update users set is_platform_admin = true where id = $1::uuid`, [userId]);
    })).rejects.toThrow(/permission denied/i);
    const check = await db.query<{ is_platform_admin: boolean }>(
      `select is_platform_admin from users where id = $1::uuid`, [userId],
    );
    expect(check.rows[0]!.is_platform_admin).toBe(false);
  });

  it('another tenant sees neither the subscription nor the payments', async () => {
    const b = await createWorkspaceWithOwner(db, {
      email: 'b@agence.fr', workspaceName: 'Agence B', locale: 'fr',
    });
    await declare();
    await confirm(await declare(), NOW);
    const stolen = await asWorkspace(db, b.workspaceId, async () => {
      const subs = await db.query<{ n: string }>(
        `select count(*)::text as n from subscriptions where workspace_id = $1::uuid`, [ws],
      );
      const pays = await db.query<{ n: string }>(
        `select count(*)::text as n from payments where workspace_id = $1::uuid`, [ws],
      );
      return { subs: Number(subs.rows[0]!.n), pays: Number(pays.rows[0]!.n) };
    });
    expect(stolen.subs).toBe(0);
    expect(stolen.pays).toBe(0);
  });

  it('audit rows are append-only for the app role (no update, no delete)', async () => {
    await declare();
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`update audit_log set action = 'tampered'`);
    })).rejects.toThrow(/permission denied/i);
    await expect(asWorkspace(db, ws, async () => {
      await db.query(`delete from audit_log`);
    })).rejects.toThrow(/permission denied/i);
  });
});
