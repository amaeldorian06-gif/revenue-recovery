import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';

export const dynamic = 'force-dynamic';

const REASON: Record<string, { fr: string; en: string }> = {
  expired: { fr: 'Cette invitation a expiré (7 jours). Demandez-en une nouvelle.', en: 'This invitation expired (7 days). Ask for a new one.' },
  used: { fr: 'Cette invitation a déjà été utilisée.', en: 'This invitation was already used.' },
  revoked: { fr: 'Cette invitation a été annulée.', en: 'This invitation was revoked.' },
  unknown: { fr: 'Invitation inconnue.', en: 'Unknown invitation.' },
  seat_limit: { fr: 'Limite de sièges atteinte (SEAT_LIMIT_REACHED) — réduisez le nombre de membres ou changez d’offre.', en: 'Seat limit reached (SEAT_LIMIT_REACHED) — remove a member or upgrade.' },
};

export default async function InviteFailedPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ reason?: string }>;
}) {
  const { locale: rawLocale } = await params;
  const { reason = 'unknown' } = await searchParams;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';
  const msg = REASON[reason]?.[fr ? 'fr' : 'en'] ?? REASON.unknown![fr ? 'fr' : 'en'];
  return (
    <section style={{ margin: '48px auto', maxWidth: 460, padding: '0 16px' }} data-testid="invite-failed">
      <h1>{fr ? 'Invitation refusée' : 'Invitation failed'}</h1>
      <p data-testid="invite-reason" style={{ fontSize: 14, color: reason === 'seat_limit' ? '#b42318' : 'inherit' }}>{msg}</p>
      <p style={{ fontSize: 13 }}><a href={`/${rawLocale}/login`}>{fr ? 'Retour à la connexion' : 'Back to login'}</a></p>
    </section>
  );
}
