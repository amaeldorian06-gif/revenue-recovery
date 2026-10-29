import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { pageMeta } from '../../../../lib/site';
import { PLANS } from '@rros/domain/entitlements';
import { TrackedCta, PagePing } from '../../../../lib/analytics_client';

export const dynamic = 'force-dynamic';

/**
 * Public pricing — the numbers and limits come from entitlements/check.ts,
 * the same constants the application enforces. The access terms describe the
 * ACTUAL flow (manual payment, activation after confirmation): no fake
 * "instant checkout" that does not exist.
 */

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const fr = locale !== 'en';
  return pageMeta(
    locale, '/pricing',
    fr ? 'Tarifs — Revenue Recovery OS' : 'Pricing — Revenue Recovery OS',
    fr ? 'Trois plans, limites claires (dossiers suivis, sièges, boîtes). Essai 14 jours sans carte bancaire, paiement par virement, sans engagement de résultat.'
       : 'Three plans, clear limits (tracked dossiers, seats, mailboxes). 14-day trial with no credit card, payment by bank transfer, no outcome guarantee.',
  );
}

const PLAN_FEATURES = (fr: boolean): Record<string, string[]> => ({
  starter: fr
    ? ['30 dossiers suivis / mois', '1 siège', '1 boîte d’envoi', 'Import CSV & priorisation expliquée', 'Exports CSV']
    : ['30 tracked dossiers / month', '1 seat', '1 sending mailbox', 'CSV import & explained prioritization', 'CSV exports'],
  growth: fr
    ? ['90 dossiers suivis / mois', '4 sièges', '2 boîtes d’envoi', 'API lecture', 'Groupe témoin (mesure d’effet)']
    : ['90 tracked dossiers / month', '4 seats', '2 sending mailboxes', 'Read API', 'Holdout group (effect measurement)'],
  scale: fr
    ? ['300 dossiers suivis / mois', '12 sièges', '5 boîtes d’envoi', 'API lecture-écriture', 'Groupe témoin paramétrable']
    : ['300 tracked dossiers / month', '12 seats', '5 sending mailboxes', 'Read-write API', 'Configurable holdout group'],
});

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) redirect('/fr');
  const fr = raw === 'fr';
  const t = (f: string, e: string) => (fr ? f : e);
  const features = PLAN_FEATURES(fr);

  return (
    <section style={{ maxWidth: 1080, margin: '0 auto', padding: '48px 20px' }}>
      <PagePing event="pricing_viewed" />
      <h2 style={{ fontSize: 32, margin: '0 0 8px' }}>{t('Trois plans, aucune surprise', 'Three plans, no surprises')}</h2>
      <p className="sub" style={{ fontSize: 15, maxWidth: 640 }}>
        {t('Les limites ci-dessous sont celles réellement appliquées par le produit. Chaque compte démarre par un essai de 14 jours en bac à sable, sans carte bancaire.',
           'The limits below are the ones the product actually enforces. Every account starts with a 14-day sandbox trial, no credit card.')}
      </p>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginTop: 24 }}>
        {Object.entries(PLANS).map(([key, p], i) => (
          <div className="card" key={key} style={i === 1 ? { borderColor: 'var(--accent)' } : undefined}>
            <div className="pad">
              {i === 1 && <span className="pill live">{t('Le plus choisi comme point de départ', 'The usual starting point')}</span>}
              <div style={{ fontWeight: 700, textTransform: 'capitalize', fontSize: 16, marginTop: i === 1 ? 8 : 0 }}>{key}</div>
              <div style={{ fontSize: 30, fontWeight: 680, margin: '8px 0' }}>
                {p.priceMonthlyEur}&nbsp;€<span className="sub" style={{ fontSize: 13 }}>/{t('mois', 'mo')}</span>
              </div>
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.8 }}>
                {(features[key] ?? []).map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 22 }}><div className="pad">
        <h3 style={{ margin: 0, fontSize: 16 }}>{t('Comment y accéder (en toute transparence)', 'How to subscribe (in full transparency)')}</h3>
        <ol style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.8 }}>
          <li>{t('Créez votre compte : l’essai de 14 jours démarre immédiatement, en bac à sable, sans carte.', 'Create your account: the 14-day trial starts immediately, in sandbox, no card.')}</li>
          <li>{t('À la fin de l’essai, choisissez un plan depuis la page Abonnement de l’application.', 'When the trial ends, pick a plan from the in-app Subscription page.')}</li>
          <li>{t('Le paiement se fait par virement bancaire (modalités affichées dans l’application) ; l’activation est confirmée par notre équipe après réception. Aucun prélèvement automatique, aucune promesse de résultat.', 'Payment is made by bank transfer (terms displayed in the app); activation is confirmed by our team after receipt. No automatic billing, no outcome guarantee.')}</li>
        </ol>
        <p className="sub" style={{ fontSize: 12.5, marginTop: 10 }}>
          {t('L’activation suit une confirmation humaine : elle ne se fait jamais sur simple déclaration du client. C’est volontaire.',
             'Activation follows human confirmation: it never happens on the customer’s word alone. That is deliberate.')}
        </p>
      </div></div>

      <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
        <TrackedCta href={`/${raw}/signup`} event="primary_cta_clicked" className="btn primary" testid="pricing-cta"
          style={{ fontSize: 15, padding: '12px 22px', textDecoration: 'none' }}>
          {t('Démarrer l’essai de 14 jours', 'Start the 14-day trial')}
        </TrackedCta>
        <a className="btn" href={`/${raw}/product`} style={{ fontSize: 15, padding: '12px 22px', textDecoration: 'none' }}>{t('Revoir le produit', 'Review the product')}</a>
      </div>
    </section>
  );
}
