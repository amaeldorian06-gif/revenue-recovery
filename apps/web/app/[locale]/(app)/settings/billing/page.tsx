import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../../lib/session';
import { currentBilling, eur } from '../../../../../lib/billing';
import { updateHoldoutAction } from '../../../../../lib/actions/holdout';
import { expectedAmountCents } from '@rros/db/licensing';

export const dynamic = 'force-dynamic';

/**
 * Billing settings WITHOUT a payment processor: the workspace's money state,
 * a pointer to the manual-licensing page (declaration + admin confirmation),
 * and the holdout control (an experimentation setting, not a payment).
 */
export default async function BillingPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { locale: rawLocale } = await params;
  const query = await searchParams;
  if (!isLocale(rawLocale)) redirect('/fr');
  const locale = rawLocale;
  const fr = locale === 'fr';
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const { state, access, usage } = await currentBilling(session);
  const error = query.error;
  const holdoutPct = await currentHoldoutPct(session.workspaceId);

  const statusLabel: Record<string, string> = fr
    ? { trialing: 'Essai', active: 'Actif', past_due: 'Paiement refusé', canceled: 'Résilié', incomplete: 'Incomplet' }
    : { trialing: 'Trial', active: 'Active', past_due: 'Payment failed', canceled: 'Canceled', incomplete: 'Incomplete' };

  return (
    <section style={{ maxWidth: 880, margin: '0 auto' }} data-testid="billing-page">
      <h2>{fr ? 'Abonnement' : 'Subscription'}</h2>

      <div className="card" style={{ margin: '14px 0' }}><div className="pad">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <strong data-testid="current-plan">{state.plan.toUpperCase()}</strong>
            {' · '}
            <span data-testid="billing-status">{statusLabel[state.subscriptionStatus]}</span>
            {state.subscriptionStatus === 'trialing' && state.trialEndsAt && (
              <span> · {fr ? 'fin le' : 'ends'} {state.trialEndsAt.toLocaleDateString(fr ? 'fr-FR' : 'en-GB')}</span>
            )}
            {' · '}
            <span>{fr ? `${usage.proposalsTracked} propositions suivies ce mois` : `${usage.proposalsTracked} proposals tracked this month`}</span>
          </div>
          <a className="btn primary" style={{ textDecoration: 'none', display: 'inline-block' }}
             href={`/${locale}/subscription`} data-testid="go-subscription">
            {fr ? 'Payer / activer le mois' : 'Pay / activate the month'}
          </a>
        </div>
        <p className="sub" style={{ marginTop: 10, fontSize: 12.5 }} data-testid="manual-payment-note">
          {fr
            ? `Paiement par virement, Chariow ou Maketou — activation après vérification manuelle par notre équipe. Paliers : Starter ${eur(expectedAmountCents('starter', 'EUR'), 'fr')}, Growth ${eur(expectedAmountCents('growth', 'EUR'), 'fr')}, Scale ${eur(expectedAmountCents('scale', 'EUR'), 'fr')} /mois.`
            : `Pay by bank transfer, Chariow or Maketou — activated after manual verification by our team. Plans: Starter ${eur(expectedAmountCents('starter', 'EUR'), 'en')}, Growth ${eur(expectedAmountCents('growth', 'EUR'), 'en')}, Scale ${eur(expectedAmountCents('scale', 'EUR'), 'en')} /mo.`}
        </p>
        {error === 'holdout' && (
          <p style={{ color: '#b42318', fontWeight: 600, marginTop: 8 }} data-testid="holdout-refused">
            {fr ? 'Le taux de groupe témoin se règle à partir de l’offre Scale (10–30 %).' : 'Holdout rate is configurable from the Scale plan (10–30%).'}
          </p>
        )}
      </div></div>

      <div className="card"><div className="pad">
        <strong>{fr ? 'Groupe témoin' : 'Holdout'}</strong>
        <p className="sub" style={{ fontSize: 13 }}>
          {fr
            ? `Taux actuel : ${holdoutPct} %. Réglable de 10 à 30 % à partir de l’offre Scale.`
            : `Current rate: ${holdoutPct}%. Configurable from 10% to 30% on the Scale plan.`}
        </p>
        <form action={updateHoldoutAction} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input type="range" name="rate" min="0.10" max="0.30" step="0.01" defaultValue="0.20" data-testid="holdout-rate" />
          <button className="btn" type="submit" data-testid="save-holdout">{fr ? 'Enregistrer' : 'Save'}</button>
        </form>
        {access.readOnly && (
          <p className="sub" style={{ marginTop: 8, fontSize: 12.5, color: '#b42318' }}>
            {fr ? 'Espace en lecture seule : réglages gelés.' : 'Read-only workspace: settings frozen.'}
          </p>
        )}
      </div></div>
    </section>
  );
}

async function currentHoldoutPct(workspaceId: string): Promise<number> {
  const { asAdmin } = await import('../../../../../lib/db');
  const r = await asAdmin((db) =>
    db.query<{ holdout_rate: string }>('select holdout_rate from workspaces where id = $1::uuid', [workspaceId]),
  );
  return Math.round(Number(r.rows[0]?.holdout_rate ?? 0.2) * 100);
}
