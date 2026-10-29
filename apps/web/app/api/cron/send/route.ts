import { NextResponse } from 'next/server';
import { asAdmin, getDb } from '../../../../lib/db';
import { sendDueAction } from '@rros/db/actions';
import { defaultEmailProvider } from '@rros/domain/sending/providers/index';
import { accessFor, type SubscriptionStatus } from '@rros/domain/billing/access';
import { enqueueWebhook, maybeUsageThreshold } from '@rros/db/team';
import { getUsage } from '@rros/db/billing';
import { PLANS } from '@rros/domain/entitlements';
import { getCurrentEntitlement } from '@rros/db/licensing';
import { jobStart, jobFinish } from '@rros/db/jobs';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

/**
 * The send job. One action per workspace per invocation, never a batch: a bug in
 * a batch sends a hundred wrong emails before anyone can react.
 *
 * Authenticated with the cron secret, never a session. Approving and sending are
 * two different steps on purpose (a double click must not send twice).
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const started = Date.now();
  const provider = defaultEmailProvider();
  const now = new Date();

  const db = await getDb();
  const runId = await asAdmin((conn) => jobStart(conn, 'cron.send'));
  const workspaces = await asAdmin((conn) =>
    conn.query<{
      id: string; subscription_status: string; owner_email: string | null;
      trial_ends_at: string | null; past_due_at: string | null;
      cancel_at_period_end: boolean; current_period_end: string | null;
    }>(
      `select w.id, w.subscription_status, u.email as owner_email,
              w.trial_ends_at, w.past_due_at, w.cancel_at_period_end, w.current_period_end
         from workspaces w
         left join users u on u.workspace_id = w.id and u.role = 'owner'
        where w.deleted_at is null`,
    ),
  );

  const results: Array<{ workspaceId: string; status: string; code?: string; sandbox?: boolean }> = [];
  for (const w of workspaces.rows) {
    // The subscription gate is computed here, from the database row, for every
    // run: past_due pauses sending, an expired trial or a cancellation freezes
    // it, and no client-supplied state can change that.
    const access = accessFor({
      subscriptionStatus: w.subscription_status as Parameters<typeof accessFor>[0]['subscriptionStatus'] & SubscriptionStatus,
      trialEndsAt: w.trial_ends_at ? new Date(w.trial_ends_at) : null,
      pastDueAt: w.past_due_at ? new Date(w.past_due_at) : null,
      cancelAtPeriodEnd: w.cancel_at_period_end,
      currentPeriodEnd: w.current_period_end ? new Date(w.current_period_end) : null,
    }, now);
    if (!access.canSend) {
      results.push({ workspaceId: w.id, status: 'skipped', code: 'subscription_paused' });
      continue;
    }

    // Licensing gate (0009): the monthly entitlement is checked from the
    // database on every run. An expired, suspended or never-confirmed
    // subscription stops sends even if old approved actions are still due.
    const license = await asAdmin((c) => getCurrentEntitlement(c, w.id, now));
    if (!license.accessAllowed) {
      results.push({ workspaceId: w.id, status: 'skipped', code: `license_${license.reasonCode}` });
      continue;
    }

    try {
      const res = await asAdmin((conn) =>
        sendDueAction(conn, {
          workspaceId: w.id,
          provider,
          now,
          sandboxOwnerEmail: w.owner_email ?? '',
          // Trial = sandbox. Nothing reaches a client before the workspace is live.
          sandboxEnabled: access.sandbox || process.env.SANDBOX_MODE === 'on',
        }),
      );
      if (res.status === 'sent') {
        await asAdmin((conn) => enqueueWebhook(conn, w.id, 'action.sent', {
          id: randomUUID(), event: 'action.sent', at: now.toISOString(), sandbox: res.sandbox === true,
        }));
        // usage.threshold — once per day, at 80 % and 100 % of the quota.
        const usage = await asAdmin((conn) => getUsage(conn, w.id, now));
        const planKey = await asAdmin((conn) =>
          conn.query<{ plan: 'starter' | 'growth' | 'scale' }>('select plan::text as plan from workspaces where id = $1::uuid', [w.id]),
        );
        const limits = PLANS[planKey.rows[0]?.plan ?? 'starter'];
        await asAdmin((conn) => maybeUsageThreshold(conn, w.id, {
          counter: 'emails', used: usage.emailsSent, limit: limits.proposalsPerMonth,
        }));
      }
      results.push({ workspaceId: w.id, status: res.status, code: res.code, sandbox: res.sandbox });
    } catch (err) {
      results.push({
        workspaceId: w.id,
        status: 'error',
        code: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
      });
    }
  }

  // The job must not keep the connection busy for the next tick.
  void db;

  const sent = results.filter((r) => r.status === 'sent').length;
  await asAdmin((conn) => jobFinish(conn, runId, results.some((r) => r.status === 'error') ? 'error' : 'ok', sent));

  return NextResponse.json({
    ok: results.every((r) => r.status !== 'error'),
    provider: provider.name,
    workspaces: results.length,
    sent,
    cancelled: results.filter((r) => r.status === 'cancelled').length,
    failed: results.filter((r) => r.status === 'failed').length,
    notApproved: results.filter((r) => r.status === 'not_approved').length,
    results,
    durationMs: Date.now() - started,
  });
}
