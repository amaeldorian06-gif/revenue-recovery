import { currentBilling } from '../lib/billing';
import { TRIAL_EXPIRED_STOPS } from '@rros/domain/billing/access';
import type { Session } from '../lib/session';

/**
 * The subscription banner. One component, every money state, always rendered
 * from the database — a trial that expired this morning shows this afternoon,
 * because nothing is cached past the request.
 */
export async function SubscriptionBanner({ session, locale }: { session: Session; locale: 'fr' | 'en' }) {
  // The shell must render even when billing cannot be read (racy access,
  // workspace being deleted): money state degrades to silence, never to a 500.
  const billing = await currentBilling(session).catch(() => null);
  if (!billing) return null;
  const { state, access, usage } = billing;
  const fr = locale === 'fr';
  const banners: React.ReactNode[] = [];

  if (access.banner) {
    const b = access.banner;
    if (b.kind === 'trial') {
      banners.push(
        <div key="trial" data-testid="banner-trial" className="banner banner-trial">
          {fr
            ? `Essai — ${b.days} jour${b.days === 1 ? '' : 's'} restant${b.days === 1 ? '' : 's'}. Envoi en bac à sable, sans carte bancaire.`
            : `Trial — ${b.days} day${b.days === 1 ? '' : 's'} left. Sandbox sending, no credit card required.`}
          <a href={`/${locale}/subscription`} className="banner-link">{fr ? 'Choisir une offre' : 'Choose a plan'}</a>
        </div>,
      );
    }
    if (b.kind === 'trial_expired') {
      banners.push(
        <div key="texp" data-testid="banner-trial-expired" className="banner banner-warn">
          {fr ? TRIAL_EXPIRED_STOPS.fr : TRIAL_EXPIRED_STOPS.en}
          <a href={`/${locale}/subscription`} className="banner-link">{fr ? 'Activer une offre' : 'Activate a plan'}</a>
        </div>,
      );
    }
    if (b.kind === 'past_due') {
      banners.push(
        <div key="pd" data-testid="banner-past-due" className="banner banner-warn">
          {fr
            ? 'Paiement refusé. L’envoi est en pause.'
            : 'Payment failed. Sending is paused.'}
          <a href={`/${locale}/subscription`} className="banner-link" data-testid="fix-billing">
            {fr ? 'Régler l’abonnement' : 'Settle the subscription'}
          </a>
        </div>,
      );
    }
    if (b.kind === 'canceled') {
      banners.push(
        <div key="cx" data-testid="banner-canceled" className="banner banner-warn">
          {fr
            ? `Abonnement résilié. Consultation et export possibles ; données supprimées après ${b.days} jours.`
            : `Subscription canceled. Reading and export still work; data is purged after ${b.days} days.`}
          <a href={`/${locale}/results/export`} className="banner-link">{fr ? 'Exporter' : 'Export'}</a>
        </div>,
      );
    }
    if (b.kind === 'canceled_soon') {
      banners.push(
        <div key="cs" data-testid="banner-cancel-soon" className="banner banner-trial">
          {fr
            ? `Résiliation programmée dans ${b.days} jour${b.days === 1 ? '' : 's'}.`
            : `Cancellation scheduled in ${b.days} day${b.days === 1 ? '' : 's'}.`}
          <a href={`/${locale}/subscription`} className="banner-link">{fr ? 'Reprendre l’abonnement' : 'Resume the subscription'}</a>
        </div>,
      );
    }
  }

  if (state.subscriptionStatus !== 'incomplete' && !access.readOnly) {
    const pctLimit = { starter: 30, growth: 90, scale: 300 }[state.plan];
    if (usage.proposalsTracked >= pctLimit) {
      banners.push(
        <div key="usage" data-testid="banner-usage" className="banner banner-warn">
          {fr
            ? `${usage.proposalsTracked}/${pctLimit} propositions suivies ce mois. Au-delà de ${Math.floor(pctLimit * 1.1)}, les nouveaux imports seront refusés — vos files continuent de fonctionner.`
            : `${usage.proposalsTracked}/${pctLimit} proposals tracked this month. Above ${Math.floor(pctLimit * 1.1)}, new imports will be refused — your queues keep working.`}
          <a href={`/${locale}/subscription`} className="banner-link">{fr ? 'Passer à l’offre supérieure' : 'Upgrade'}</a>
        </div>,
      );
    }
  }

  if (banners.length === 0) return null;
  return <div data-testid="banners">{banners}</div>;
}
