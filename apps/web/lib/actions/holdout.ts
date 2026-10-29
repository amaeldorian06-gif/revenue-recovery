import { redirect } from 'next/navigation';
import { getSession } from '../../lib/session';
import { asAdmin, getDb } from '../../lib/db';
import { assertEntitlement } from '@rros/db/billing';

/**
 * Holdout configuration — the only survivor of the old billing actions:
 * it is an experimentation control, not a payment. Everything Stripe
 * (checkout, portal, fake-pay, signed webhooks) was removed with the
 * payment processor; activation now lives in lib/actions/licensing.ts.
 */
export async function updateHoldoutAction(formData: FormData): Promise<void> {
  'use server';
  const session = await getSession();
  if (!session) redirect('/fr/login');
  const rate = Number(formData.get('rate'));
  const db = await getDb();
  const { decision } = await asAdmin((conn) =>
    assertEntitlement(conn, session.workspaceId, 'configure_holdout', { requestedHoldoutRate: rate }),
  );
  if (!decision.allowed) redirect(`/${session.locale}/settings/billing?error=holdout`);
  await asAdmin((conn) =>
    conn.query('update workspaces set holdout_rate = $2::numeric where id = $1::uuid',
      [session.workspaceId, rate]),
  );
  redirect(`/${session.locale}/settings/billing?holdout=saved`);
}
