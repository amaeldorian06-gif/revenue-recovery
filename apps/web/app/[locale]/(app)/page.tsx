import { redirect } from 'next/navigation';
import { translator, isLocale } from '@rros/i18n';
import { getSession } from '../../../lib/session';
import { withTenant } from '../../../lib/db';
import { portfolioSummary } from '@rros/db/imports';
import { getTodayQueue, getRejectionSummary } from '../../../lib/queue';
import { QueueBoard } from '../../../components/QueueBoard';
import { RefreshQueue } from '../../../components/RefreshQueue';
import { CoachMark } from '../../../components/CoachMark';
import { getOnboardingState } from '@rros/db/onboarding';
import { asAdmin } from '../../../lib/db';
import { REJECTION_LABELS, type RejectionCode } from '@rros/domain/queue/eligibility';
import { cookies } from 'next/headers';
import { recordEvent } from '../../../lib/analytics';

export const dynamic = 'force-dynamic';

const eur = (locale: 'fr' | 'en') => (c: number) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(c / 100);

export default async function TodayPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ coach?: string }>;
}) {
  const { locale } = await params;
  const { coach } = await searchParams;
  if (!isLocale(locale)) return null;
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const tr = translator(locale);
  const money = eur(locale);

  // Read through the tenant helper: RLS is active, the JWT claim comes from the session.
  const ws = await withTenant(session?.workspaceId ?? null, async (db) =>
    db.query<{ name: string; plan: string; trial_ends_at: string | null; daily_capacity: number }>(
      'select name, plan, trial_ends_at, daily_capacity from workspaces',
    ),
  );
  const workspace = ws.rows[0];
  const summary = await withTenant(session?.workspaceId ?? null, (db) =>
    portfolioSummary(db, session!.workspaceId),
  );
  const share = summary.total > 0 ? Math.round((summary.unanswered / summary.total) * 100) : 0;

  const queue = session ? await getTodayQueue(session) : null;
  const items = queue?.items ?? [];

  // Engagement répétable (analytics_events) — les jalons d'activation restent
  // dans funnel_events (une seule fois). Best-effort : ne casse jamais la vue.
  {
    const anid = (await cookies()).get('rros_anid')?.value ?? null;
    const localeOk = locale === 'en' ? 'en' : 'fr';
    await asAdmin((db) =>
      recordEvent(db, {
        name: 'prioritization_viewed',
        path: `/${locale}`,
        locale: localeOk,
        anonymousId: anid,
        workspaceId: session?.workspaceId ?? null,
      }));
  }
  const emptyReasons = session && items.length === 0 && summary.total > 0
    ? await getRejectionSummary(session)
    : null;

  // The coach-mark: requested by the onboarding hand-off (?coach=1), shown
  // once, ever — the dismissal lives in onboarding_state.
  let showCoach = false;
  if (coach === '1' && session) {
    const st = await asAdmin((db) => getOnboardingState(db, session.workspaceId));
    showCoach = st.coachDismissedAt === null;
  }

  const today = new Date().toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <section>
      <div style={{ margin: '22px 0 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <h2>{tr('today.title')}</h2>
          <p className="sub">{tr('today.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12.5, color: 'var(--ink-2)', textTransform: 'capitalize' }}>{today}</span>
          {items.length > 0 && <RefreshQueue locale={locale} />}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 18 }}>
        {[
          { label: 'Propositions', value: summary.total.toLocaleString('fr-FR') },
          { label: 'Sans réponse', value: summary.total > 0 ? `${share} %` : '—' },
          { label: '€ exposés', value: money(summary.exposedCents) },
          { label: 'Groupe témoin', value: String(summary.holdout) },
        ].map((k) => (
          <div className="card" key={k.label}>
            <div className="pad">
              <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--ink-2)', fontWeight: 600 }}>
                {k.label}
              </div>
              <div style={{ fontSize: 24, fontWeight: 680, letterSpacing: '-.8px', marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
                {k.value}
              </div>
            </div>
          </div>
        ))}
      </div>

      {summary.total === 0 && (
        <div className="card">
          <div className="pad empty">
            <div className="ico">◷</div>
            <h2 style={{ marginTop: 10 }}>{tr('today.empty.title')}</h2>
            <p className="sub" style={{ maxWidth: 460, margin: '6px auto 0' }}>
              {tr('today.empty.body')}
            </p>
            <a className="btn primary" href={`/${locale}/import`} style={{ marginTop: 14 }}>
              {locale === 'fr' ? 'Importer un fichier' : 'Import a file'}
            </a>
          </div>
        </div>
      )}

      {showCoach && items.length > 0 && <CoachMark locale={locale} />}

      {items.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
            <strong style={{ fontSize: 13.5 }}>
              {locale === 'fr'
                ? `${items.length}/${summary.total} traités`
                : `${items.length}/${summary.total} handled`}
            </strong>
            <div style={{ flex: 1, height: 5, background: '#eef0f3', borderRadius: 99, maxWidth: 260 }}>
              <div
                style={{
                  height: 5, borderRadius: 99, background: 'var(--accent)',
                  width: `${Math.min(100, Math.round((items.length / Math.max(1, summary.total)) * 100))}%`,
                }}
              />
            </div>
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {locale === 'fr' ? `capacité ${workspace?.daily_capacity ?? 8}/jour` : `capacity ${workspace?.daily_capacity ?? 8}/day`}
            </span>
          </div>

          <QueueBoard
            items={items}
            locale={locale}
            today={queue?.generatedFor ?? ''}
            totalOpportunities={summary.total}
          />
        </>
      )}

      {summary.total > 0 && items.length === 0 && emptyReasons && (
        <div className="card">
          <div className="pad">
            <h3 style={{ margin: 0, fontSize: 15 }}>
              {locale === 'fr' ? 'Rien à faire aujourd’hui — et voici pourquoi' : 'Nothing to do today — and here is why'}
            </h3>
            <p className="sub" style={{ marginTop: 4 }}>
              {locale === 'fr'
                ? 'Chaque dossier du portefeuille a été examiné. Aucun ne doit être relancé aujourd’hui.'
                : 'Every dossier was examined. None should be followed up today.'}
            </p>
            <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.9 }}>
              {(Object.entries(emptyReasons.byCode) as [RejectionCode, number][])
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([code, n]) => (
                  <li key={code}>
                    <strong style={{ color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>{n}</strong>{' '}
                    {REJECTION_LABELS[code][locale]}
                  </li>
                ))}
            </ul>
            <a className="btn" href={`/${locale}/pipeline`} style={{ marginTop: 14 }}>
              {locale === 'fr' ? 'Voir le portefeuille' : 'See the portfolio'}
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
