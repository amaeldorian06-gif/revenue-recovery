import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../lib/session';
import {
  connectSmtpMailboxAction, connectSandboxMailboxAction, disconnectMailboxAction,
  toggleStoreBodyAction, syncNowAction, listMailboxes, storeBodyEnabled, recentAuditEvents,
} from '../../../../lib/actions/mailboxes';
import { TeamSettings } from '../../../../components/TeamSettings';
import { DeleteWorkspaceForm } from '../../../../components/DeleteWorkspaceForm';
import { requestExportAction } from '../../../../lib/actions/team';
import { asAdmin } from '../../../../lib/db';

async function workspaceName(id: string): Promise<string> {
  return asAdmin(async (c) => {
    const r = await c.query<{ name: string }>('select name from workspaces where id = $1::uuid', [id]);
    return r.rows[0]?.name ?? '';
  });
}

export const dynamic = 'force-dynamic';

const PROVIDER_LABEL: Record<string, { fr: string; en: string }> = {
  gmail_oauth: { fr: 'Gmail (OAuth)', en: 'Gmail (OAuth)' },
  smtp_imap: { fr: 'SMTP / IMAP', en: 'SMTP / IMAP' },
  sandbox: { fr: 'Bac à sable', en: 'Sandbox' },
};

const AUDIT_LABEL: Record<string, { fr: string; en: string }> = {
  contact_opt_out: { fr: 'Contact désinscrit', en: 'Contact opted out' },
  'contact.opt_out': { fr: 'Contact désinscrit (stop)', en: 'Contact opted out (stop)' },
  'bounce.alerted': { fr: 'Rebond — owner alerté', en: 'Bounce — owner alerted' },
  'reply.bounce': { fr: 'Rebond détecté', en: 'Bounce detected' },
  'mailbox.revoked': { fr: 'Boîte déconnectée', en: 'Mailbox disconnected' },
  'retention.purged': { fr: 'Purge rétention 90 j', en: '90-day retention purge' },
};

export default async function SettingsPage({
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

  const isOwner = session.role === 'owner';
  const mailboxes = await listMailboxes(session.workspaceId);
  const storeBody = await storeBodyEnabled(session.workspaceId);
  const audit = recentAuditEvents(session.workspaceId);
  const error = query.error;

  return (
    <section style={{ marginTop: 22, maxWidth: 780 }} data-testid="settings-page">
      <h2>{fr ? 'Réglages' : 'Settings'}</h2>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="pad">
          <strong>{fr ? 'Boîtes de réception' : 'Mailboxes'}</strong>
          <p className="sub" style={{ fontSize: 12.5 }}>
            {fr
              ? 'La synchronisation lit les réponses toutes les 10 minutes et arrête la séquence dès qu’un client répond. Premier raccordement : 90 jours et 500 messages au maximum, pour ne jamais aspirer une boîte entière.'
              : 'Sync reads replies every 10 minutes and stops the sequence the moment a client answers. First connection: 90 days and 500 messages at most, so a mailbox is never swallowed whole.'}
          </p>
          {error === 'mailbox_limit' && (
            <p data-testid="mailbox-limit" style={{ color: '#b42318', fontWeight: 600, fontSize: 13 }}>
              {fr ? 'Limite de boîtes atteinte pour votre offre.' : 'Mailbox limit reached for your plan.'}
            </p>
          )}
          {error === 'mailbox_fields' && <p style={{ color: '#b42318', fontSize: 13 }}>{fr ? 'Hôte, utilisateur et mot de passe sont requis.' : 'Host, user and password are required.'}</p>}
          {query.mailbox === 'disconnected' && (
            <p data-testid="mailbox-disconnected" style={{ color: '#067647', fontWeight: 600, fontSize: 13 }}>
              {fr ? 'Boîte déconnectée — jetons supprimés, historique des réponses conservé.' : 'Mailbox disconnected — tokens deleted, reply history kept.'}
            </p>
          )}
          {query.mailbox === 'synced' && <p data-testid="mailbox-synced" style={{ color: '#067647', fontSize: 13 }}>{fr ? 'Synchronisation terminée.' : 'Sync finished.'}</p>}
          {query.team === 'SEAT_LIMIT_REACHED' && (
            <p data-testid="seat-limit" style={{ color: '#b42318', fontWeight: 600, fontSize: 13 }}>
              {fr ? 'Limite de sièges atteinte (SEAT_LIMIT_REACHED) — l’invitation existe mais ne peut pas être acceptée.' : 'Seat limit reached (SEAT_LIMIT_REACHED) — the invitation exists but cannot be accepted.'}
            </p>
          )}
          {typeof query.invited === 'string' && query.invited && (
            <p data-testid="invite-link" style={{ background: '#f2f7ff', border: '1px solid var(--accent)', borderRadius: 8, padding: '8px 12px', fontSize: 13, wordBreak: 'break-all' }}>
              {fr ? 'Lien d’invitation (affiché une seule fois, envoyé par e-mail en production) :' : 'Invitation link (shown once, emailed in production):'}{' '}
              <code>{query.invited}</code>
            </p>
          )}
          {typeof query.api_key_created === 'string' && query.api_key_created && (
            <p data-testid="api-key-created" style={{ background: '#f2f7ff', border: '1px solid var(--accent)', borderRadius: 8, padding: '8px 12px', fontSize: 13, wordBreak: 'break-all' }}>
              {fr ? 'Clé API — affichée UNE SEULE FOIS :' : 'API key — shown ONCE:'} <code>{query.api_key_created}</code>
            </p>
          )}
          {typeof query.webhook_secret === 'string' && query.webhook_secret && (
            <p data-testid="webhook-secret" style={{ background: '#f2f7ff', border: '1px solid var(--accent)', borderRadius: 8, padding: '8px 12px', fontSize: 13, wordBreak: 'break-all' }}>
              {fr ? 'Secret de signature — affiché UNE SEULE FOIS :' : 'Signing secret — shown ONCE:'} <code>{query.webhook_secret}</code>
            </p>
          )}
          {query.webhook === 'test_queued' && <p style={{ color: '#067647', fontSize: 13 }}>{fr ? 'Événement de test envoyé.' : 'Test event dispatched.'}</p>}
          {query.webhook === 'ssrf_blocked' && <p style={{ color: '#b42318', fontSize: 13 }}>{fr ? 'URL refusée (réseau privé interdit, HTTPS requis).' : 'URL refused (private ranges blocked, HTTPS required).'}</p>}
          {query.export === 'ready' && typeof query.file === 'string' && (
            <p data-testid="export-ready" style={{ color: '#067647', fontSize: 13 }}>
              {fr ? 'Export prêt (24 h) :' : 'Export ready (24 h):'} <a href={query.file}>{fr ? 'télécharger le ZIP' : 'download the ZIP'}</a>
            </p>
          )}

          <div style={{ marginTop: 10 }}>
            {mailboxes.length === 0 && (
              <p className="sub" style={{ fontSize: 13 }}>
                {fr ? 'Aucune boîte connectée — mode bac à sable.' : 'No mailbox connected — sandbox mode.'}
              </p>
            )}
            {mailboxes.map((m) => (
              <div key={m.id} data-testid="mailbox-row" style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--line-2)', flexWrap: 'wrap' }}>
                <strong style={{ fontSize: 13.5 }}>{PROVIDER_LABEL[m.provider]?.[locale] ?? m.provider}</strong>
                <span style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{m.email ?? ''}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: m.status === 'connected' ? '#067647' : 'var(--ink-3)' }} data-testid={`mailbox-status-${m.status}`}>
                  {m.status === 'connected' ? (fr ? 'connectée' : 'connected') : (fr ? 'déconnectée' : 'disconnected')}
                </span>
                <span style={{ fontSize: 12, color: 'var(--ink-3)', marginLeft: 'auto' }} data-testid="mailbox-last-sync">
                  {m.lastSyncAt
                    ? (fr ? `dernière sync ${m.lastSyncAt.toLocaleTimeString(fr ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}` : `last sync ${m.lastSyncAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`)
                    : (fr ? 'jamais synchronisée' : 'never synced')}
                </span>
                {m.status === 'connected' && (
                  <form action={disconnectMailboxAction}>
                    <input type="hidden" name="mailboxId" value={m.id} />
                    <button className="btn" type="submit" data-testid="disconnect-mailbox" style={{ padding: '4px 10px', fontSize: 12 }}>
                      {fr ? 'Déconnecter' : 'Disconnect'}
                    </button>
                  </form>
                )}
              </div>
            ))}
            {mailboxes.some((m) => m.lastError) && (
              <p data-testid="mailbox-error" style={{ color: '#b42318', fontSize: 12.5, marginTop: 8 }}>
                {fr ? 'Erreur de synchronisation :' : 'Sync error:'}{' '}
                {mailboxes.find((m) => m.lastError)?.lastError}
              </p>
            )}
          </div>

          <details style={{ marginTop: 12 }}>
            <summary style={{ fontSize: 13, cursor: 'pointer', fontWeight: 600 }}>
              {fr ? 'Connecter une boîte SMTP / IMAP' : 'Connect an SMTP / IMAP mailbox'}
            </summary>
            <form action={connectSmtpMailboxAction} style={{ display: 'grid', gap: 8, marginTop: 10, maxWidth: 420 }}>
              <input name="host" placeholder={fr ? 'serveur IMAP (imap.exemple.fr)' : 'IMAP host'} required style={input} data-testid="imap-host" />
              <input name="port" type="number" defaultValue={993} style={input} />
              <input name="user" placeholder="utilisateur" required style={input} />
              <input name="password" type="password" placeholder={fr ? 'mot de passe d’application (chiffré)' : 'app password (encrypted)'} required minLength={8} style={input} data-testid="imap-password" />
              <input name="email" placeholder={fr ? 'adresse d’envoi' : 'sending address'} style={input} />
              <button className="btn" type="submit" data-testid="connect-imap">
                {fr ? 'Connecter (TLS obligatoire)' : 'Connect (TLS required)'}
              </button>
            </form>
          </details>

          <form action={connectSandboxMailboxAction} style={{ marginTop: 10 }}>
            <button className="btn" type="submit" data-testid="connect-sandbox-mailbox" style={{ padding: '5px 10px', fontSize: 12 }}>
              {fr ? 'Ajouter la boîte bac à sable (démo)' : 'Add the sandbox mailbox (demo)'}
            </button>
          </form>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="pad">
          <strong>{fr ? 'Confidentialité' : 'Privacy'}</strong>
          <form action={toggleStoreBodyAction} style={{ marginTop: 8 }}>
            <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" name="store_body" defaultChecked={storeBody} data-testid="store-body" />
              <span>
                {fr
                  ? 'Conserver le texte intégral des messages. Par défaut non : seuls les en-têtes, les participants, la date et un extrait de 1 000 caractères sont stockés, et tout est purgé au-delà de 90 jours. Le texte aide à relire une négociation ; il ne sert à rien au classement.'
                  : 'Keep full message bodies. Off by default: headers, participants, date and a 1 000-character snippet only, and everything is purged after 90 days. Bodies help reread a negotiation; the ranking never needed them.'}
              </span>
            </label>
            <button className="btn" type="submit" style={{ marginTop: 10, padding: '5px 12px', fontSize: 12.5 }} data-testid="save-privacy">
              {fr ? 'Enregistrer' : 'Save'}
            </button>
          </form>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="pad" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13.5 }}>{fr ? 'Synchroniser maintenant' : 'Sync now'}</strong>
          <form action={syncNowAction}>
            <button className="btn" type="submit" data-testid="sync-now" style={{ padding: '5px 12px', fontSize: 12.5 }}>
              {fr ? 'Lancer une passe' : 'Run one pass'}
            </button>
          </form>
          <span className="sub" style={{ fontSize: 12 }}>
            {fr ? 'Le cron fait le travail toutes les 10 minutes ; ce bouton n’est là que pour vérifier.' : 'The cron runs every 10 minutes; this button only exists to check.'}
          </span>
        </div>
      </div>

      <TeamSettings session={session} />

      <div className="card" style={{ marginTop: 12 }} data-testid="gdpr-card">
        <div className="pad">
          <strong>{fr ? 'Données (RGPD)' : 'Data (GDPR)'}</strong>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <form action={requestExportAction}>
              <button className="btn" type="submit" data-testid="export-request" style={{ padding: '5px 12px', fontSize: 12.5 }}>
                {fr ? 'Exporter mes données (ZIP)' : 'Export my data (ZIP)'}
              </button>
            </form>
            <a href={`/${locale}/legal/data-processing`} style={{ fontSize: 13 }}>{fr ? 'Ce que nous stockons' : 'What we store'}</a>
          </div>
          {isOwner && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ fontSize: 13, cursor: 'pointer', color: '#b42318', fontWeight: 600 }}>
                {fr ? 'Supprimer cet espace de travail' : 'Delete this workspace'}
              </summary>
              <p style={{ fontSize: 13 }}>
                {fr
                  ? 'Tapez le nom de l’espace pour confirmer. Accès révoqués immédiatement, purge définitive sous 30 jours.'
                  : 'Type the workspace name to confirm. Access revoked immediately, hard purge within 30 days.'}
              </p>
              <DeleteWorkspaceForm locale={locale} name={(await workspaceName(session.workspaceId))} />
            </details>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }} data-testid="audit-view">
        <div className="pad">
          <strong>{fr ? 'Audit vie privée' : 'Privacy audit'}</strong>
          <p className="sub" style={{ fontSize: 12.5 }}>
            {fr
              ? 'Désinscriptions, rebonds, déconnexions et purges — les faits, jamais les contenus. Un contact désinscrit est exclu pour toujours, même du groupe témoin.'
              : 'Opt-outs, bounces, disconnections and purges — the facts, never the contents. An opted-out contact is excluded forever, holdout included.'}
          </p>
          <div style={{ marginTop: 8 }}>
            {(await audit).length === 0 && (
              <p className="sub" style={{ fontSize: 13 }}>
                {fr ? 'Aucun événement pour l’instant.' : 'No events yet.'}
              </p>
            )}
            {(await audit).map((e, i) => (
              <div key={`${e.action}-${i}`} data-testid="audit-row" style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '6px 0', borderBottom: '1px solid var(--line-2)' }}>
                <span style={{ fontWeight: 600, minWidth: 170 }}>{AUDIT_LABEL[e.action]?.[locale] ?? e.action}</span>
                <span style={{ color: 'var(--ink-3)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {e.createdAt.toLocaleString(fr ? 'fr-FR' : 'en-GB')}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const input = { padding: '8px 12px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 13.5 } as const;
