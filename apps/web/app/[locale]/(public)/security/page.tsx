import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { pageMeta } from '../../../../lib/site';

export const dynamic = 'force-dynamic';

/**
 * Public security page — ONLY verified facts, with the gaps stated as gaps
 * (§16: no certification or compliance claims without documented status).
 * Each "in place" item below is enforced in code AND exercised by automated
 * tests in this repository (rls.test.ts, auth flows, session revocation
 * checks). Claims without implementation would be worse than no page.
 */

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const fr = locale !== 'en';
  return pageMeta(
    locale, '/security',
    fr ? 'Sécurité — Revenue Recovery OS' : 'Security — Revenue Recovery OS',
    fr ? 'Mesures de sécurité réellement en place, vérifiées par tests automatiques : cloisonnement des espaces, sessions révocables, en-têtes stricts. Limites assumées, certifications : aucune.'
       : 'Security measures actually in place, verified by automated tests: workspace isolation, revocable sessions, strict headers. Stated limits, certifications: none.',
  );
}

export default async function SecurityPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) redirect('/fr');
  const fr = raw === 'fr';
  const t = (f: string, e: string) => (fr ? f : e);

  const inPlace: Array<[string, string]> = fr ? [
    ['Cloisonnement par espace de travail (RLS + grants)',
     'Chaque requête applicative porte l’espace de la session vérifiée côté serveur. Les politiques RLS et les grants SQL sont testés automatiquement à chaque suite (y compris tentatives inter-espaces refusées).'],
    ['Sessions révocables côté serveur',
     'Un cookie volé ne vaut plus rien après révocation : la validité est revérifiée en base à chaque requête, et la rotation réémet une session en révoquant l’ancienne.'],
    ['Connexion par lien à usage unique',
     'Le lien de connexion est haché (SHA-256), consommé de façon atomique — un rejeu est refusé — et expire. Les tentatives échouées sont limitées par adresse IP (5 en 15 minutes).'],
    ['En-têtes HTTP stricts',
     'CSP avec nonce par requête (aucun script inline sans nonce, pas de unsafe-eval en production), HSTS, X-Frame-Options DENY, Referrer-Policy et Permissions-Policy restrictives.'],
    ['Validation systématique des entrées',
     'Toute entrée API passe par des schémas fermés (énumérations, bornes) ; le tri, les filtres et les identifiants ne sont jamais interpolés en SQL.'],
    ['Journal d’audit',
     'Les actions sensibles sont journalisées ; rétention 12 mois puis anonymisation. La suppression d’un espace déclenche une purge en cascade sous 30 jours.'],
    ['Secrets côté serveur uniquement',
     'Aucune clé de service n’est exposée au navigateur ; les identifiants de boîtes mail sont chiffrés au repos.'],
    ['Export réversible de vos données',
     'Archive ZIP de toutes les tables de votre espace à la demande — vos données restent les vôtres.'],
  ] : [
    ['Workspace isolation (RLS + grants)',
     'Every application request carries the workspace of the server-verified session. RLS policies and SQL grants are automatically tested in every run, including refused cross-workspace attempts.'],
    ['Server-side revocable sessions',
     'A stolen cookie becomes worthless after revocation: validity is re-checked against the database on every request, and rotation re-issues a session while revoking the old one.'],
    ['Single-use login links',
     'The login link is hashed (SHA-256), atomically consumed — replays are refused — and expires. Failed attempts are rate-limited per IP (5 per 15 minutes).'],
    ['Strict HTTP headers',
     'CSP with a per-request nonce (no inline scripts without a nonce, no unsafe-eval in production), HSTS, X-Frame-Options DENY, restrictive Referrer-Policy and Permissions-Policy.'],
    ['Systematic input validation',
     'Every API input goes through closed schemas (enums, bounds); sorting, filters and identifiers are never interpolated into SQL.'],
    ['Audit log',
     'Sensitive actions are logged; 12-month retention then anonymisation. Deleting a workspace triggers a cascading purge within 30 days.'],
    ['Secrets stay server-side',
     'No service key is exposed to the browser; mailbox credentials are encrypted at rest.'],
    ['Reversible data export',
     'ZIP archive of every table in your workspace on demand — your data stays yours.'],
  ];

  const honest: Array<[string, string]> = fr ? [
    ['Certifications : aucune',
     'Nous n’avons ni SOC 2, ni ISO 27001, ni attestation similaire — et nous ne les revendiquons pas. Ne nous demandez pas un rapport qui n’existe pas.'],
    ['Double authentification (2FA) : pas encore',
     'La connexion repose sur le lien à usage unique et les sessions révocables. Un second facteur est sur la feuille de route ; il n’est pas en place aujourd’hui.'],
    ['Hébergement et sous-traitants',
     'Aujourd’hui, base de données locale à l’instance et envoi d’e-mails via votre boîte connectée ; la liste à jour des sous-traitants (et du planned hosting managé) figure dans les mentions légales.'],
    ['Conformité RGPD',
     'Le produit applique des principes RGPD (minimisation, rétentions documentées, droit à la suppression effectif) ; ce n’est pas une certification et cela ne remplace pas votre propre analyse juridique.'],
  ] : [
    ['Certifications: none',
     'We hold no SOC 2, no ISO 27001, no similar attestation — and we do not claim any. Do not ask us for a report that does not exist.'],
    ['Two-factor authentication (2FA): not yet',
     'Sign-in relies on the single-use link and revocable sessions. A second factor is on the roadmap; it is not in place today.'],
    ['Hosting and sub-processors',
     'Today, a database local to the instance and email sending through your connected mailbox; the current sub-processor list (and the upcoming managed hosting) is in the legal notice.'],
    ['GDPR',
     'The product applies GDPR principles (minimisation, documented retention, effective right to deletion); this is not a certification and does not replace your own legal review.'],
  ];

  return (
    <section style={{ maxWidth: 900, margin: '0 auto', padding: '48px 20px' }}>
      <h2 style={{ fontSize: 32, margin: '0 0 8px' }}>{t('Sécurité : ce qui est vrai', 'Security: what is true')}</h2>
      <p className="sub" style={{ fontSize: 15 }}>
        {t('Cette page liste uniquement des mesures implémentées dans le produit et exercées par des tests automatisés. Ce qui manque est dit aussi franchement.',
           'This page lists only measures implemented in the product and exercised by automated tests. What is missing is stated just as plainly.')}
      </p>

      <h3 style={{ fontSize: 19, margin: '26px 0 10px' }}>{t('En place et testé', 'In place and tested')}</h3>
      <div className="grid" style={{ gap: 10 }}>
        {inPlace.map(([h, p]) => (
          <div className="card" key={h}><div className="pad" style={{ padding: 14 }}>
            <div style={{ fontWeight: 650, fontSize: 14.5 }}>✓ {h}</div>
            <p className="sub" style={{ fontSize: 13, marginTop: 6 }}>{p}</p>
          </div></div>
        ))}
      </div>

      <h3 style={{ fontSize: 19, margin: '26px 0 10px' }}>{t('Limites assumées', 'Stated limitations')}</h3>
      <div className="grid" style={{ gap: 10 }}>
        {honest.map(([h, p]) => (
          <div className="card" key={h} style={{ borderLeft: '3px solid var(--warn-line)' }}><div className="pad" style={{ padding: 14 }}>
            <div style={{ fontWeight: 650, fontSize: 14.5 }}>{h}</div>
            <p className="sub" style={{ fontSize: 13, marginTop: 6 }}>{p}</p>
          </div></div>
        ))}
      </div>

    </section>
  );
}
