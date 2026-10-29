import { getBillingState, getUsage, type BillingState, type Usage } from '@rros/db/billing';
import { accessFor, type Access } from '@rros/domain/billing/access';
import { asAdmin } from './db';
import type { Session } from './session';

/**
 * Billing read-side for the UI. There is NO payment processor here anymore —
 * Stripe was removed entirely (RAPPORT_RETRAIT_STRIPE.md). The state shown is
 * the trial lifecycle plus the manual-licensing mirror (workspaces columns),
 * and activation happens through /subscription with an admin confirmation.
 */

export async function currentBilling(session: Session): Promise<{
  state: BillingState;
  access: Access;
  usage: Usage;
}> {
  return asAdmin(async (db) => {
    const state = await getBillingState(db, session.workspaceId);
    const usage = await getUsage(db, session.workspaceId);
    return { state, access: accessFor(state, new Date()), usage };
  });
}

export const eur = (cents: number, locale: 'fr' | 'en'): string =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(cents / 100);
