import { listMailboxes } from '../lib/actions/mailboxes';
import type { Session } from '../lib/session';

/**
 * A sync error is visible in the app shell, not only in settings — a mailbox
 * that stopped syncing silently is how follow-ups go out to clients who
 * already answered.
 */
export async function SyncHealthBanner({ session, locale }: { session: Session; locale: 'fr' | 'en' }) {
  const mailboxes = await listMailboxes(session.workspaceId);
  const broken = mailboxes.filter((m) => m.status === 'connected' && m.lastError !== null);
  if (broken.length === 0) return null;
  return (
    <div data-testid="banner-sync-error" className="banner banner-warn">
      {locale === 'fr'
        ? `Synchronisation en échec sur ${broken.length === 1 ? 'une boîte' : `${broken.length} boîtes`} — les réponses ne sont plus détectées. `
        : `Sync failing on ${broken.length} mailbox${broken.length > 1 ? 'es' : ''} — replies are not detected anymore. `}
      <a href={`/${locale}/settings`} className="banner-link">{locale === 'fr' ? 'Voir l’erreur' : 'See the error'}</a>
    </div>
  );
}
