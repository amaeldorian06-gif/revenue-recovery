import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';

export const dynamic = 'force-dynamic';

/** Exactly what is stored and for how long — the phase prompt asks for this page by name. */
export default async function DataProcessingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';
  const rows: Array<[string, string, string]> = [
    [fr ? 'Comptes (e-mail, rôle, nom)' : 'Accounts (email, role, name)', fr ? 'Vie du compte' : 'Life of the account', fr ? 'Espace users' : 'users table'],
    [fr ? 'Dossiers & contacts importés' : 'Imported dossiers & contacts', fr ? 'Vie du compte' : 'Life of the account', fr ? 'Espaces opportunities, contacts' : 'opportunities, contacts tables'],
    [fr ? 'Corps d’e-mail des réponses' : 'Reply email bodies', fr ? 'Non stocké par défaut ; si activé : 90 jours' : 'Not stored by default; if enabled: 90 days', 'mail_messages.body'],
    [fr ? 'Extraits de messages' : 'Message snippets', '90 jours' , 'mail_messages.snippet'],
    [fr ? 'Jetons OAuth / mots de passe IMAP' : 'OAuth tokens / IMAP passwords', fr ? 'Chiffrés, jusqu’à déconnexion' : 'Encrypted, until disconnect', 'mailbox_connections.credentials_encrypted'],
    [fr ? 'Clés API (hachage SHA-256)' : 'API keys (SHA-256 hash)', fr ? 'Jusqu’à révocation' : 'Until revoked', 'api_keys.key_hash'],
    [fr ? 'Secrets de webhook' : 'Webhook secrets', fr ? 'Chiffrés, jusqu’à suppression' : 'Encrypted, until removed', 'webhook_endpoints.secret'],
    [fr ? 'Journal d’audit' : 'Audit log', fr ? '12 mois puis anonymisation' : '12 months then anonymised', 'audit_log'],
    [fr ? 'Journal d’appels API (comptages, codes)' : 'API call journal (counts, codes)', '30 minutes' , 'api_requests'],
  ];
  return (
    <section style={{ margin: '26px auto', maxWidth: 820, padding: '0 16px', fontSize: 14 }} data-testid="data-processing-page">
      <h1>{fr ? 'Ce que nous stockons, et pour combien de temps' : 'What we store, and for how long'}</h1>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', borderBottom: '2px solid var(--line-2)', padding: 8 }}>{fr ? 'Donnée' : 'Data'}</th>
            <th style={{ textAlign: 'left', borderBottom: '2px solid var(--line-2)', padding: 8 }}>{fr ? 'Durée' : 'Retention'}</th>
            <th style={{ textAlign: 'left', borderBottom: '2px solid var(--line-2)', padding: 8 }}>{fr ? 'Où' : 'Where'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r[2]}>
              <td style={{ padding: 8, borderBottom: '1px solid var(--line-2)' }}>{r[0]}</td>
              <td style={{ padding: 8, borderBottom: '1px solid var(--line-2)' }}>{r[1]}</td>
              <td style={{ padding: 8, borderBottom: '1px solid var(--line-2)', fontFamily: 'monospace', fontSize: 12.5 }}>{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
