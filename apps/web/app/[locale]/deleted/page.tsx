import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { destroySession } from '../../../lib/session';

/** Private or tokenized page: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

export default async function DeletedPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';
  await destroySession();
  return (
    <section style={{ margin: '48px auto', maxWidth: 520, padding: '0 16px' }} data-testid="deleted-page">
      <h1>{fr ? 'Espace de travail supprimé' : 'Workspace deleted'}</h1>
      <p style={{ fontSize: 14 }}>
        {fr
          ? 'Tous les accès sont révoqués immédiatement. La suppression définitive intervient dans 30 jours ; d’ici là, une restauration reste possible en nous écrivant.'
          : 'All access is revoked immediately. The hard purge happens in 30 days; until then a restore is still possible by contacting us.'}
      </p>
    </section>
  );
}
