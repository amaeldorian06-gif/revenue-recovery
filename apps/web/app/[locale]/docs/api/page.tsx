import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';

export const dynamic = 'force-dynamic';

/**
 * The API documentation page. Redoc renders the OpenAPI spec when the CDN is
 * reachable; the server-rendered reference below is the complete fallback —
 * a doc page that renders nothing is a doc page nobody integrates against.
 */
export default async function ApiDocsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';

  const rows: Array<[string, string, string]> = [
    ['GET', '/api/v1/opportunities', fr ? "Lister les dossiers — filtres status, arm, since, limit (≤ 100), curseur" : 'List opportunities — status, arm, since, limit (≤ 100), cursor'],
    ['GET', '/api/v1/recommendations', fr ? "La file classée d'un jour (?date=YYYY-MM-DD, défaut : aujourd'hui)" : "A day's ranked queue (?date=YYYY-MM-DD, default today)"],
    ['POST', '/api/v1/actions', fr ? 'Créer un BROUILLON — ne peut ni approuver ni envoyer, jamais' : 'Create a DRAFT — can never approve or send'],
    ['POST', '/api/v1/replies', fr ? 'Enregistrer une réponse externe et arrêter la séquence' : 'Record an external reply and stop the sequence'],
    ['GET', '/api/v1/results', fr ? 'Résultats A/B/C avec intervalles et significance' : 'A/B/C results with intervals and significance'],
    ['GET', '/api/v1/usage', fr ? 'Compteurs de la période en cours' : 'Current-period counters'],
  ];

  return (
    <section style={{ margin: '22px auto', maxWidth: 860, padding: '0 16px' }}>
      <h1>{fr ? 'API publique v1' : 'Public API v1'}</h1>
      <p style={{ background: '#fff8e6', border: '1px solid #e6c200', borderRadius: 8, padding: '10px 14px', fontSize: 14 }}>
        {fr
          ? "L'API prépare, n'envoie jamais. POST /v1/actions crée un brouillon ; aucun endpoint ne permet à une clé d'approuver ou d'expédier un message. C'est un invariant produit, pas une limitation."
          : 'The API prepares, it never sends. POST /v1/actions creates a draft; no endpoint lets a key approve or dispatch a message. It is a product invariant, not a limitation.'}
      </p>
      <p style={{ fontSize: 13.5 }}>
        Auth: <code>Authorization: Bearer rrs_live_…</code> · {fr ? 'Limite' : 'Rate limit'}: 120 req/min ·{' '}
        <a href="/api/v1/openapi.json" style={{ color: '#0b6b4f' }}>OpenAPI 3.1</a>
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
        <tbody>
          {rows.map(([method, path, desc]) => (
            <tr key={path}>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 700, color: method === 'GET' ? '#0b6b4f' : '#b45309', width: 54 }}>{method}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #e5e7eb', fontFamily: 'monospace' }}>{path}</td>
              <td style={{ padding: '7px 8px', borderBottom: '1px solid #e5e7eb' }}>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div id="redoc-container" />
      <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js" async defer />
      <script
        dangerouslySetInnerHTML={{
          __html: `window.addEventListener('load',function(){try{if(window.Redoc)Redoc.init('/api/v1/openapi.json',{hideDownloadButton:false},document.getElementById('redoc-container'))}catch(e){}});`,
        }}
      />
    </section>
  );
}
