'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../lib/session';
import { asAdmin, withTenant } from '../../lib/db';
import { getEntitlement, isPlatformAdmin, PRODUCT_ID } from '../../lib/licensing';
import { expectedAmountCents, submitPaymentDeclaration, confirmPaymentAndActivateSubscription, suspendSubscription, reactivateSubscription } from '@rros/db/licensing';
import { PLANS, type Plan } from '@rros/domain/entitlements';
import { log } from '../../lib/obs';

const PLANS_LIST = ['starter', 'growth', 'scale'] as const;
const METHODS = ['bank_transfer', 'chariow', 'maketou'] as const;
const CURRENCIES = ['EUR', 'XAF'] as const;

const METHOD_LABEL: Record<string, { fr: string; en: string }> = {
  bank_transfer: { fr: 'Virement bancaire', en: 'Bank transfer' },
  chariow: { fr: 'Chariow', en: 'Chariow' },
  maketou: { fr: 'Maketou', en: 'Maketou' },
};

function badRequest(): never {
  throw new Error('invalid_input');
}

/**
 * Customer declaration. Amount typed by the customer is WHAT THEY CLAIM to
 * have paid — it is checked for sanity here and verified against actual
 * receipt by the administrator at confirmation. A declaration never changes
 * access: the entitlement code path does not even look at it.
 */
export async function submitDeclarationAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const plan = String(formData.get('plan') ?? '') as Plan;
  const currency = String(formData.get('currency') ?? '') as 'EUR' | 'XAF';
  const method = String(formData.get('payment_method') ?? '') as 'bank_transfer' | 'chariow' | 'maketou';
  const reference = String(formData.get('external_reference') ?? '').trim().slice(0, 120) || null;
  const amountRaw = String(formData.get('amount') ?? '').replace(/\s/g, '').replace(',', '.');
  const amount = Number(amountRaw);
  if (!PLANS_LIST.includes(plan) || !CURRENCIES.includes(currency) || !METHODS.includes(method)) badRequest();
  if (!Number.isFinite(amount) || amount <= 0) badRequest();
  const amountCents = currency === 'EUR' ? Math.round(amount * 100) : Math.round(amount);

  await asAdmin((db) =>
    submitPaymentDeclaration(db, {
      workspaceId: session.workspaceId, userId: session.userId, plan,
      amountCents, currency, method: method as 'bank_transfer' | 'chariow' | 'maketou',
      externalReference: reference, now: new Date(),
    }),
  ).then((r) => {
    if (!r.ok) redirect(`/${session.locale}/subscription?error=${r.code}`);
  });
  log('info', { route: '/subscription', code: 'declaration_submitted' });
  revalidatePath(`/${session.locale}/subscription`);
  redirect(`/${session.locale}/subscription?sent=1`);
}

/** Administrator: confirm one payment — the single activation path. */
export async function confirmPaymentAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  if (!(await isPlatformAdmin(session.userId))) redirect(`/${session.locale}`);
  const paymentId = String(formData.get('paymentId') ?? '');
  if (!/^[0-9a-f-]{36}$/.test(paymentId)) badRequest();
  const result = await asAdmin((db) =>
    confirmPaymentAndActivateSubscription(db, { paymentId, adminUserId: session.userId, now: new Date() }),
  );
  if (!result.ok) redirect(`/${session.locale}/admin/licenses?error=${result.code}`);
  log('info', { route: '/admin/licenses', code: result.code });
  revalidatePath(`/${session.locale}/admin/licenses`);
  redirect(`/${session.locale}/admin/licenses?done=${result.code}`);
}

/** Administrator: reject with a reason (goes to the customer's history). */
export async function rejectPaymentAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  if (!(await isPlatformAdmin(session.userId))) redirect(`/${session.locale}`);
  const paymentId = String(formData.get('paymentId') ?? '');
  const reason = String(formData.get('reason') ?? 'unverified').slice(0, 120);
  if (!/^[0-9a-f-]{36}$/.test(paymentId)) badRequest();
  await asAdmin(async (db) => {
    // Only a pending payment can be rejected; the row state is the guard.
    const r = await db.query<{ workspace_id: string }>(
      `update payments set status = 'rejected', rejection_reason = $2,
              validated_by = $3::uuid, validated_at = now()
        where id = $1::uuid and status = 'pending' returning workspace_id`,
      [paymentId, reason, session.userId],
    );
    if (r.rows[0]) {
      await db.query(
        `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
         values ($1::uuid, 'user', $2::uuid, 'payment.rejected', 'payment', $3, $4::jsonb)`,
        [r.rows[0].workspace_id, session.userId, paymentId, JSON.stringify({ reason })],
      );
    }
  });
  revalidatePath(`/${session.locale}/admin/licenses`);
  redirect(`/${session.locale}/admin/licenses?done=rejected`);
}

/** Administrator: suspend (immediate access loss) or reactivate explicitly. */
export async function suspendAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  if (!(await isPlatformAdmin(session.userId))) redirect(`/${session.locale}`);
  const workspaceId = String(formData.get('workspaceId') ?? '');
  if (!/^[0-9a-f-]{36}$/.test(workspaceId)) badRequest();
  await asAdmin((db) => suspendSubscription(db, workspaceId, session.userId, new Date()));
  revalidatePath(`/${session.locale}/admin/licenses`);
  redirect(`/${session.locale}/admin/licenses?done=suspended`);
}

export async function reactivateAction(formData: FormData): Promise<void> {
  const session = await getSession();
  if (!session) redirect('/fr/login');
  if (!(await isPlatformAdmin(session.userId))) redirect(`/${session.locale}`);
  const workspaceId = String(formData.get('workspaceId') ?? '');
  const months = Number(formData.get('months') ?? 0);
  if (!/^[0-9a-f-]{36}$/.test(workspaceId) || !Number.isInteger(months) || months < 0 || months > 12) badRequest();
  await asAdmin((db) => reactivateSubscription(db, workspaceId, session.userId, new Date(), months));
  revalidatePath(`/${session.locale}/admin/licenses`);
  redirect(`/${session.locale}/admin/licenses?done=reactivated`);
}
