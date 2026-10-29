import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { acceptInviteAction } from '../../../../lib/actions/team';

/** Private or tokenized page: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

const REASON: Record<string, { fr: string; en: string }> = {
  expired: { fr: 'Cette invitation a expiré (7 jours). Demandez-en une nouvelle.', en: 'This invitation expired (7 days). Ask for a new one.' },
  used: { fr: 'Cette invitation a déjà été utilisée.', en: 'This invitation was already used.' },
  revoked: { fr: 'Cette invitation a été annulée.', en: 'This invitation was revoked.' },
  unknown: { fr: 'Invitation inconnue.', en: 'Unknown invitation.' },
  seat_limit: { fr: 'La limite de sièges de l’offre est atteinte — l’invitation ne peut pas être acceptée.', en: 'The plan seat limit is reached — the invitation cannot be accepted.' },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale: rawLocale, token } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';
  return (
    <section style={{ margin: '48px auto', maxWidth: 460, padding: '0 16px' }} data-testid="invite-page">
      <h1>{fr ? 'Rejoindre l’équipe' : 'Join the team'}</h1>
      <p style={{ fontSize: 14 }}>
        {fr
          ? 'Vous avez été invité(e) sur Revenue Recovery OS. Accepter crée votre compte avec le rôle choisi par la personne qui vous a invité(e).'
          : 'You have been invited to Revenue Recovery OS. Accepting creates your account with the role chosen by whoever invited you.'}
      </p>
      <form action={acceptInviteAction}>
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="locale" value={rawLocale} />
        <button className="btn primary" type="submit" data-testid="accept-invite">
          {fr ? 'Accepter l’invitation' : 'Accept the invitation'}
        </button>
      </form>
    </section>
  );
}
