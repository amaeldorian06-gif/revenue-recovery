import { redirect } from 'next/navigation';
import { translator, isLocale } from '@rros/i18n';
import { getSession } from '../../../../lib/session';
import { withTenant } from '../../../../lib/db';
import { readResults } from '@rros/db/measurement';
import { ResultsView } from '../../../../components/ResultsView';

export const dynamic = 'force-dynamic';

/**
 * The results screen. Everything it shows comes from one precomputed row per
 * week — no bootstrap on a page load, so the screen opens in milliseconds and the
 * number never changes because someone refreshed.
 */
export default async function ResultsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) redirect('/fr');
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const tr = translator(locale);

  const payload = await withTenant(session.workspaceId, (db) =>
    readResults(db, { workspaceId: session.workspaceId, locale }),
  );

  if (!payload) {
    return (
      <section style={{ marginTop: 22 }}>
        <h2>{tr('nav.results')}</h2>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="pad">
            {locale === 'fr'
              ? 'Aucune expérience de mesure n’est ouverte pour cet espace de travail.'
              : 'No measurement experiment is open for this workspace.'}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section style={{ marginTop: 20 }}>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>{tr('nav.results')}</h2>
        <p className="sub" style={{ margin: '2px 0 0' }}>
          {locale === 'fr'
            ? 'Trois chiffres, toujours ensemble — le causal, le brut, et ce qui se serait passé sans nous.'
            : 'Three figures, always together — the causal one, the gross one, and what would have happened without us.'}
        </p>
      </div>

      <ResultsView
        locale={locale}
        data={{
          headline: payload.headline,
          attribution: {
            weekStart: payload.attribution.weekStart,
            estimateCents: payload.attribution.estimateCents,
            ciLow: payload.attribution.ciLow,
            ciHigh: payload.attribution.ciHigh,
            pValue: payload.attribution.pValue,
            significant: payload.attribution.significant,
            nTreatment: payload.attribution.nTreatment,
            nHoldout: payload.attribution.nHoldout,
            revenueBCents: payload.attribution.revenueBCents,
            revenueCCents: payload.attribution.revenueCCents,
            requiredPerArm: payload.attribution.requiredPerArm,
            coherenceVerdict: payload.attribution.coherenceVerdict,
          },
          series: payload.series,
          weeks: payload.weeks,
          weeksMeasured: payload.weeksMeasured,
          holdoutCount: payload.holdoutCount,
          experimentStatus: payload.experiment.status,
        }}
      />
    </section>
  );
}
