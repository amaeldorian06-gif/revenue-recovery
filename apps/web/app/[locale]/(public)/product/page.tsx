import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { pageMeta, SITE_URL } from '../../../../lib/site';
import { PLANS } from '@rros/domain/entitlements';
import { TrackedCta, PagePing } from '../../../../lib/analytics_client';

export const dynamic = 'force-dynamic';

/**
 * The public product page. Every claim on this page maps to shipped code:
 * CSV import with mapping/preview (phase 02), explainable scoring (domain/
* scoring, ENGINE_VERSION 2026-10-v1), 14-day sandbox trial (0009), the real
 * plan limits (entitlements/check.ts). Nothing recovered-percentage-shaped,
 * no customer logo, no testimonial: none of it exists yet, so none of it is
 * written.
 */

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const fr = locale !== 'en';
  return pageMeta(
    locale, '/product',
    fr ? 'Priorisez vos créances impayées — Revenue Recovery OS'
       : 'Prioritize your overdue receivables — Revenue Recovery OS',
    fr ? 'Importez vos créances, voyez quels comptes relancer en premier et pourquoi. Explications lisibles, essai 14 jours sans carte bancaire, envoi en bac à sable.'
       : 'Import your receivables, see which accounts to chase first and why. Readable explanations, 14-day trial with no credit card, sandbox sending.',
  );
}

export default async function ProductPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) redirect('/fr');
  const fr = raw === 'fr';
  const t = (f: string, e: string) => (fr ? f : e);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: 'Revenue Recovery OS',
        url: SITE_URL,
      },
      {
        '@type': 'SoftwareApplication',
        name: 'Revenue Recovery OS',
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Web',
        description: t(
          'Couche de priorisation des créances B2B : import CSV, score expliqué, relances organisées.',
          'B2B receivables prioritization layer: CSV import, explained scoring, organized follow-ups.',
        ),
        offers: Object.entries(PLANS).map(([, p]) => ({
          '@type': 'Offer',
          price: p.priceMonthlyEur,
          priceCurrency: 'EUR',
          description: `${p.proposalsPerMonth} ${t('dossiers/mois', 'dossiers/mo')}`,
        })),
      },
    ],
  };

  const steps = [
    {
      n: '1',
      h: t('Importez votre CSV', 'Import your CSV'),
      p: t('Exportez vos factures ouvertes depuis votre outil de facturation. Détection des colonnes, mapping vérifiable, aperçu avant tout enregistrement, rapport d’import détaillé (importées, mises à jour, ignorées, erreurs).',
           'Export your open invoices from your invoicing tool. Column detection, verifiable mapping, preview before anything is saved, detailed import report (imported, updated, skipped, errors).'),
    },
    {
      n: '2',
      h: t('Lisez la priorisation, pas un mystère', 'Read the prioritization, not a mystery'),
      p: t('Chaque dossier reçoit une priorité calculée par un moteur documenté (valeur attendue de la relance × urgence) avec ses facteurs affichés : ouvertures, historique de réponse, maturité du dossier, silence, montant. L’indice de priorité n’est pas une probabilité d’impayé.',
           'Each dossier gets a priority computed by a documented engine (expected follow-up value × urgency) with its factors displayed: opens, reply history, dossier maturity, silence, amount. The priority index is not a default probability.'),
    },
    {
      n: '3',
      h: t('Organisez l’action suivante', 'Organize the next action'),
      p: t('La file du jour propose quoi faire maintenant ; les brouillons de relance restent soumis à validation humaine ; un groupe témoin optionnel (holdout) permet de mesurer ce que la relance change réellement.',
           'The daily queue proposes what to do now; follow-up drafts stay under human validation; an optional holdout group lets you measure what follow-up actually changes.'),
    },
  ];

  const faq = [
    {
      q: t('Remplace-t-il mon logiciel de facturation ou de comptabilité ?', 'Does it replace my invoicing or accounting software?'),
      a: t('Non. Revenue Recovery OS est une couche de priorisation au-dessus de votre outil existant : vous importez un CSV, vous décidez, vous agissez. Aucune écriture comptable, aucune connexion bancaire.',
           'No. Revenue Recovery OS is a prioritization layer on top of your existing tool: you import a CSV, you decide, you act. No accounting entries, no bank connection.'),
    },
    {
      q: t('Faut-il connecter mes comptes bancaires ?', 'Do I have to connect my bank accounts?'),
      a: t('Jamais. Aucun accès bancaire n’est demandé ni utilisé. Le produit travaille sur les données que vous importez.',
           'Never. No bank access is requested or used. The product works on the data you import.'),
    },
    {
      q: t('Le produit envoie-t-il des e-mails tout seul ?', 'Does the product send emails on its own?'),
      a: t('Non. Pendant l’essai, l’envoi est en bac à sable. Les brouillons proposés nécessitent une validation humaine avant tout envoi réel.',
           'No. During the trial, sending runs in sandbox mode. Proposed drafts require human validation before any real sending.'),
    },
    {
      q: t('Que se passe-t-il avec mon fichier CSV ?', 'What happens to my CSV file?'),
      a: t('Il est analysé (colonnes, encodage), vous validez le mapping et l’aperçu, puis les lignes deviennent des dossiers dans VOTRE espace. Les données restent cloisonnées par espace (RLS testée) et la suppression du compte entraîne une purge complète sous 30 jours.',
           'It is analyzed (columns, encoding), you validate the mapping and the preview, then rows become dossiers in YOUR workspace. Data stays workspace-isolated (tested RLS) and account deletion triggers a full purge within 30 days.'),
    },
    {
      q: t('D’où vient la priorité affichée ?', 'Where does the displayed priority come from?'),
      a: t('D’un moteur de score documenté et testé, recalibrable par espace. Les facteurs sont affichés avec chaque dossier ; si les données sont insuffisantes, le produit le dit au lieu d’inventer un chiffre.',
           'From a documented, tested scoring engine, recalibrable per workspace. Factors are displayed with each dossier; when data is insufficient, the product says so instead of inventing a number.'),
    },
    {
      q: t('Puis-je récupérer mes données ?', 'Can I get my data back?'),
      a: t('Oui. L’export inclut l’ensemble des tables de votre espace (archive ZIP), en plus des exports CSV par vue.',
           'Yes. Export includes every table of your workspace (ZIP archive), in addition to per-view CSV exports.'),
    },
  ];

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <PagePing event="landing_page_view" />

      {/* 1 — Hero : la promesse, le pour qui, le comment, le pas suivant. */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '56px 20px 30px' }}>
        <span className="pill live">{t('Essai 14 jours · sans carte bancaire · envoi en bac à sable', '14-day trial · no credit card · sandbox sending')}</span>
        <h2 style={{ fontSize: 40, lineHeight: 1.15, margin: '16px 0 12px', maxWidth: 820, letterSpacing: '-0.5px' }}>
          {t('Priorisez vos créances impayées.', 'Prioritize your overdue receivables.')}
          <br />
          <span style={{ color: 'var(--accent-ink)' }}>{t('Savez qui relancer, et pourquoi.', 'Know who to chase, and why.')}</span>
        </h2>
        <p style={{ fontSize: 17, color: 'var(--ink-2)', maxWidth: 700 }}>
          {t('Revenue Recovery OS lit vos factures ouvertes, calcule quels comptes méritent votre attention en premier et affiche les raisons de chaque priorité. Une couche de décision pour les équipes qui gèrent encore les relances dans un tableeur.',
             'Revenue Recovery OS reads your open invoices, computes which accounts deserve attention first and shows the reasons behind every priority. A decision layer for teams still chasing payments in a spreadsheet.')}
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 22, flexWrap: 'wrap' }}>
          <TrackedCta href={`/${raw}/signup`} event="primary_cta_clicked" className="btn primary" testid="hero-cta"
            style={{ fontSize: 15, padding: '12px 22px', textDecoration: 'none' }}>
            {t('Commencer l’essai gratuit', 'Start the free trial')}
          </TrackedCta>
          <TrackedCta href={`/${raw}/pricing`} event="secondary_cta_clicked" className="btn" testid="hero-pricing"
            style={{ fontSize: 15, padding: '12px 22px', textDecoration: 'none' }}>
            {t('Voir les tarifs', 'See pricing')}
          </TrackedCta>
        </div>
      </section>

      {/* 4 — Capture réelle du produit (aucune maquette retouchée). */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '0 20px 26px' }}>
        <figure className="card" style={{ margin: 0, padding: 10 }}>
          <img src="/screenshots/creances-priorisation.png"
               alt={t('Capture d’écran réelle : vue « Créances » du produit, avec encours ouvert, montants échus, indice de priorité et facteurs d’explication par client',
                      'Real product screenshot: the “Receivables” view with open outstanding, overdue amounts, priority index and explanation factors per customer')}
               style={{ width: '100%', borderRadius: 8, border: '1px solid var(--line-2)' }} />
          <figcaption className="sub" style={{ padding: '10px 6px 4px', fontSize: 12.5 }}>
            {t('Vue réelle « Créances » : encours, échu (terme 30 j), indice de priorité par client et facteurs d’explication.',
               'Real “Receivables” view: outstanding, overdue (30-day term), per-customer priority index and explanation factors.')}
          </figcaption>
        </figure>
      </section>

      {/* 5 — Trois étapes. */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '18px 20px' }}>
        <h2 style={{ fontSize: 24 }}>{t('Comment ça marche', 'How it works')}</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginTop: 14 }}>
          {steps.map((s) => (
            <div className="card" key={s.n}><div className="pad">
              <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--accent-soft)', color: 'var(--accent-ink)', display: 'grid', placeItems: 'center', fontWeight: 700, marginBottom: 10 }}>{s.n}</div>
              <h3 style={{ margin: 0, fontSize: 16 }}>{s.h}</h3>
              <p className="sub" style={{ marginTop: 8 }}>{s.p}</p>
            </div></div>
          ))}
        </div>
      </section>

      {/* 6 — Cas d’usage. */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '18px 20px' }}>
        <h2 style={{ fontSize: 24 }}>{t('Pour qui', 'Who it is for')}</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 14 }}>
          {[
            [t('Agences et cabinets de conseil', 'Agencies and consultancies'),
             t('Beaucoup de clients, beaucoup de petites factures échues, personne à plein temps sur les relances.', 'Many clients, many small overdue invoices, nobody full-time on collections.')],
            [t('PME de services B2B', 'B2B service SMBs'),
             t('La trésorerie dépend de quelques dizaines de comptes à relancer chaque semaine, sans CRM ni ERP.', 'Cash flow depends on a few dozen accounts to chase weekly, with no CRM or ERP.')],
            [t('Équipes finance sur tableurs', 'Finance teams on spreadsheets'),
             t('Le suivi existe déjà — dans un fichier. La priorisation, l’explication et le suivi manquent.', 'Tracking already exists — in a file. Prioritization, explanation and follow-through are missing.')],
          ].map(([h, p]) => (
            <div className="card" key={h}><div className="pad">
              <h3 style={{ margin: 0, fontSize: 15.5 }}>{h}</h3>
              <p className="sub" style={{ marginTop: 8 }}>{p}</p>
            </div></div>
          ))}
        </div>
      </section>

      {/* 7 — Bénéfices = hypothèses mesurables, PAS des résultats fabriqués. */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '18px 20px' }}>
        <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}><div className="pad">
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>{t('Ce que le produit peut améliorer — à mesurer chez vous', 'What the product can improve — to be measured on your data')}</h2>
          <p className="sub" style={{ fontSize: 13.5 }}>
            {t('Aucun chiffre de récupération n’est promis ici : la mesure honnête passe par le groupe témoin intégré (holdout) et vos propres données. Hypothèses de travail :',
               'No recovery percentage is promised here: honest measurement comes from the built-in holdout group and your own data. Working hypotheses:')}
          </p>
          <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7 }}>
            <li>{t('Réduire le temps passé à décider quoi relancer (tri remplacé par une file expliquée).', 'Reduce time spent deciding what to chase (sorting replaced by an explained queue).')}</li>
            <li>{t('Relancer les bons comptes plus tôt, grâce aux signaux observés (ouvertures, réponses).', 'Chase the right accounts sooner, thanks to observed signals (opens, replies).')}</li>
            <li>{t('Rendre le résultat mesurable : montants relancés, relances envoyées, effet vu sur le groupe témoin.', 'Make the outcome measurable: chased amounts, sent follow-ups, holdout-measured effect.')}</li>
          </ul>
        </div></div>
      </section>

      {/* 8 — Transparence CSV. 9 — Sécurité réelle. */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '18px 20px', display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <div className="card"><div className="pad">
          <h2 style={{ fontSize: 18, margin: 0 }}>{t('Vos données CSV, en clair', 'Your CSV data, in plain words')}</h2>
          <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7 }}>
            <li>{t('Aperçu systématique avant enregistrement ; rapport d’import avec lignes ignorées et raisons.', 'Systematic preview before saving; import report with skipped rows and reasons.')}</li>
            <li>{t('Encodages courants gérés ; détection de colonnes proposée, jamais imposée.', 'Common encodings handled; column detection proposed, never imposed.')}</li>
            <li>{t('Les données importées vivent dans votre espace, cloisonnées et supprimables ; voir la page dédiée à la rétention.', 'Imported data lives in your workspace, isolated and deletable; see the retention page.')}</li>
          </ul>
          <p style={{ margin: '10px 0 0', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <a href="/downloads/modele-suivi-creances.csv" download style={{ color: 'var(--accent-ink)' }}>{t('Modèle de suivi créances (CSV, sans inscription) ↓', 'Receivables tracking template (CSV, no signup) ↓')}</a>
            <a href="/downloads/exemple-creances.csv" download style={{ color: 'var(--accent-ink)' }}>{t('Fichier d’exemple (données 100 % fictives) ↓', 'Sample file (100% fictional data) ↓')}</a>
          </p>
          <p style={{ margin: '10px 0 0' }}><a href={`/${raw}/legal/data-processing`} style={{ color: 'var(--accent-ink)' }}>{t('Détail complet : ce que nous stockons et combien de temps →', 'Full detail: what we store and for how long →')}</a></p>
        </div></div>
        <div className="card"><div className="pad">
          <h2 style={{ fontSize: 18, margin: 0 }}>{t('Sécurité : ce qui est réellement en place', 'Security: what is actually in place')}</h2>
          <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 14, color: 'var(--ink-2)', lineHeight: 1.7 }}>
            <li>{t('Cloisonnement par espace testé automatiquement (RLS et grants, à chaque suite de tests).', 'Workspace isolation automatically tested (RLS and grants, in every test run).')}</li>
            <li>{t('Sessions révocables, lien de connexion à usage unique, limitation des tentatives.', 'Revocable sessions, single-use login link, attempt rate limiting.')}</li>
            <li>{t('En-têtes stricts (CSP avec nonce, HSTS). Pas de certification SOC 2 / ISO : nous ne le prétendons pas.', 'Strict headers (CSP with nonce, HSTS). No SOC 2 / ISO certification: we do not claim one.')}</li>
          </ul>
          <p style={{ margin: '10px 0 0' }}><a href={`/${raw}/security`} style={{ color: 'var(--accent-ink)' }}>{t('Détail des mesures et de leurs limites →', 'Measures and their limits in detail →')}</a></p>
        </div></div>
      </section>

      {/* 10 — Tarifs (aperçu honnête, limites réelles du code). */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '18px 20px' }}>
        <h2 style={{ fontSize: 24 }}>{t('Tarifs simples', 'Simple pricing')}</h2>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', marginTop: 14 }}>
          {Object.entries(PLANS).map(([key, p]) => (
            <div className="card" key={key}><div className="pad">
              <div style={{ fontWeight: 700, textTransform: 'capitalize' }}>{key}</div>
              <div style={{ fontSize: 24, fontWeight: 680, margin: '6px 0' }}>{p.priceMonthlyEur}&nbsp;€<span className="sub" style={{ fontSize: 12 }}>/{t('mois', 'mo')}</span></div>
              <div className="sub" style={{ fontSize: 12.5 }}>{p.proposalsPerMonth} {t('dossiers suivis / mois', 'tracked dossiers / mo')} · {p.seats} {t('siège(s)', 'seat(s)')}</div>
            </div></div>
          ))}
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 13.5 }}><a href={`/${raw}/pricing`} style={{ color: 'var(--accent-ink)' }}>{t('Détail des plans et modalités d’accès →', 'Plan details and access terms →')}</a></p>
      </section>

      {/* 11 — FAQ. */}
      <section style={{ maxWidth: 880, margin: '0 auto', padding: '18px 20px' }}>
        <h2 style={{ fontSize: 24 }}>{t('Questions fréquentes', 'Frequently asked questions')}</h2>
        <div style={{ marginTop: 10 }}>
          {faq.map((f) => (
            <details key={f.q} className="card" style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', padding: '13px 16px', fontWeight: 620, fontSize: 14.5 }}>{f.q}</summary>
              <p className="sub" style={{ padding: '0 16px 14px', fontSize: 13.5 }}>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* 12 — Conversion finale. */}
      <section style={{ maxWidth: 1180, margin: '0 auto', padding: '26px 20px 44px' }}>
        <div className="card" style={{ background: 'var(--accent-soft)', borderColor: '#a7f3d0' }}><div className="pad" style={{ textAlign: 'center', padding: 34 }}>
          <h2 style={{ fontSize: 26, margin: '0 0 8px' }}>{t('Voyez votre prochaine priorité dès le premier import.', 'See your next priority from the very first import.')}</h2>
          <p className="sub" style={{ fontSize: 14.5 }}>{t('Importez un fichier d’exemple ou vos propres données — l’aperçu est gratuit, l’essai de 14 jours n’exige pas de carte bancaire.', 'Import a sample file or your own data — the preview is free and the 14-day trial needs no credit card.')}</p>
          <TrackedCta href={`/${raw}/signup`} event="primary_cta_clicked" className="btn primary" testid="final-cta"
            style={{ fontSize: 15, padding: '12px 24px', marginTop: 14, textDecoration: 'none' }}>
            {t('Créer mon compte', 'Create my account')}
          </TrackedCta>
        </div></div>
      </section>
    </>
  );
}
