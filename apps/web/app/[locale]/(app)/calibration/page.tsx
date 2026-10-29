import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../lib/session';
import { withTenant } from '../../../../lib/db';
import { portfolioSummary } from '@rros/db/imports';

const eur = (c: number) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100);

export default async function CalibrationPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) return null;
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const s = await withTenant(session.workspaceId, (db) => portfolioSummary(db, session.workspaceId));
  const share = s.total > 0 ? Math.round((s.unanswered / s.total) * 100) : 0;

  return (
    <section style={{ marginTop: 22, maxWidth: 760 }}>
      <h2>Voilà ce que nous avons trouvé</h2>
      <p className="sub">Étape 4 sur 4 · rien à configurer, les chiffres parlent d&apos;eux-mêmes.</p>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 18 }}>
        {[
          { label: 'Propositions', value: s.total.toLocaleString('fr-FR'), foot: 'dans votre portefeuille' },
          { label: 'Sans réponse', value: `${share} %`, foot: `${s.unanswered} dossiers` },
          { label: 'Montant exposé', value: eur(s.exposedCents), foot: 'encore ouvert' },
          { label: 'Groupe témoin', value: String(s.holdout), foot: 'mesure du gain réel' },
        ].map((k) => (
          <div className="card" key={k.label}>
            <div className="pad">
              <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--ink-2)', fontWeight: 600 }}>{k.label}</div>
              <div style={{ fontSize: 23, fontWeight: 680, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}>{k.foot}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 16, borderColor: '#d9d6fe', background: 'linear-gradient(180deg,#faf9ff,#fff)' }}>
        <div className="pad">
          <strong style={{ fontSize: 14 }}>Pourquoi {s.holdout} dossiers ne recevront aucune action de notre part</strong>
          <p style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.65, margin: '8px 0 0' }}>
            Ils ont été tirés au hasard. Ils restent visibles dans votre portefeuille, mais le système
            ne les relancera pas. C&apos;est ce groupe qui nous permettra de vous dire, dans six mois,
            ce que le produit vous a réellement rapporté — au lieu de vous montrer un chiffre
            d&apos;activité en le faisant passer pour un gain. Nous ne savons pas mesurer autrement.
          </p>
        </div>
      </div>

      <a className="btn primary" href={`/${locale}`} style={{ marginTop: 18 }}>
        Voir ma file du jour
      </a>
    </section>
  );
}
