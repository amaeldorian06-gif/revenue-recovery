import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../lib/session';
import { withTenant } from '../../../../lib/db';
import { classify, topValueThreshold, type DetectionState } from '@rros/domain/classify';
import { checkEligibility } from '@rros/domain/queue/eligibility';
import { isoDate } from '@rros/db/queue';
import { OpportunityForm } from '../../../../components/OpportunityForm';

const STATES: DetectionState[] = ['no_reply', 'late_action', 'abnormal_silence', 'watch'];
const STATE_FR: Record<DetectionState, string> = {
  no_reply: 'Sans réponse',
  late_action: 'Action en retard',
  abnormal_silence: 'Silence anormal',
  watch: 'À surveiller',
};

const eur = (c: number) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100);

interface Row {
  id: string; client_name: string; title: string | null; amount_cents: string;
  stage: string; sent_at: string; last_touch_at: string | null; touch_count: number;
  reply_received_at: string | null; status: string; arm: string; expected_action_at: string | null;
}

export default async function Page({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const { locale } = await params;
  const { state: stateFilter } = await searchParams;
  if (!isLocale(locale)) return null;
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const rows = await withTenant(session.workspaceId, (db) =>
    db.query<Row>(
      `select id, client_name, title, amount_cents, stage, sent_at, last_touch_at, touch_count,
              reply_received_at, status, arm, expected_action_at
         from opportunities
        order by sent_at desc
        limit 500`,
    ),
  );

  const now = new Date();
  // What the Today screen already asked for today, and what is eligible but did
  // not fit the daily capacity. Without this the user cannot tell a dossier that
  // is waiting its turn from one the engine has simply decided not to touch.
  const inQueue = new Set(
    (
      await withTenant(session.workspaceId, (db) =>
        db.query<{ opportunity_id: string }>(
          `select opportunity_id from recommendations
            where workspace_id = $1::uuid and generated_for = $2::date`,
          [session.workspaceId, isoDate(now)],
        ),
      )
    ).rows.map((r) => r.opportunity_id),
  );

  const threshold = topValueThreshold(
    rows.rows.filter((r) => r.status === 'open').map((r) => Number(r.amount_cents)),
  );
  const items = rows.rows.map((r) => {
    const c = classify({
      amountCents: Number(r.amount_cents), stage: r.stage, sentAt: r.sent_at,
      lastTouchAt: r.last_touch_at, touchCount: r.touch_count,
      replyReceivedAt: r.reply_received_at, status: r.status,
      expectedActionAt: r.expected_action_at, now, topValueThresholdCents: threshold,
    });
    const verdict = checkEligibility(
      {
        arm: r.arm as 'treatment' | 'holdout',
        status: r.status,
        touchCount: r.touch_count,
        sentAt: r.sent_at,
        lastTouchAt: r.last_touch_at,
        replyReceivedAt: r.reply_received_at,
      },
      now,
    );
    const queueState: 'in_queue' | 'waiting' | null = inQueue.has(r.id)
      ? 'in_queue'
      : verdict.eligible
        ? 'waiting'
        : null;
    return { ...r, ...c, queueState };
  });

  const counts = STATES.reduce<Record<string, number>>((acc, s) => {
    acc[s] = items.filter((i) => i.state === s).length;
    return acc;
  }, {});
  const visible = stateFilter === 'in_queue'
    ? items.filter((i) => i.queueState === 'in_queue')
    : stateFilter === 'waiting'
      ? items.filter((i) => i.queueState === 'waiting')
      : stateFilter && STATES.includes(stateFilter as DetectionState)
        ? items.filter((i) => i.state === stateFilter)
        : items;

  return (
    <section style={{ marginTop: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <h2>Portefeuille</h2>
          <p className="sub">
            {items.length} proposition{items.length > 1 ? 's' : ''} suivie{items.length > 1 ? 's' : ''} ·
            état recalculé à chaque affichage, jamais stocké.
          </p>
        </div>
        <a className="btn primary" href={`/${locale}/import`}>
          Importer un fichier
        </a>
      </div>

      {items.length > 0 && (
        <div className="filters">
          <a href={`/${locale}/pipeline`} aria-current={!stateFilter}>Tout ({items.length})</a>
          <a href={`/${locale}/pipeline?state=in_queue`} aria-current={stateFilter === 'in_queue'}>
            Dans la file du jour ({items.filter((i) => i.queueState === 'in_queue').length})
          </a>
          <a href={`/${locale}/pipeline?state=waiting`} aria-current={stateFilter === 'waiting'}>
            À traiter ({items.filter((i) => i.queueState === 'waiting').length})
          </a>
          {STATES.map((s) => (
            <a key={s} href={`/${locale}/pipeline?state=${s}`} aria-current={stateFilter === s}>
              {STATE_FR[s]} ({counts[s]})
            </a>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 14, overflow: 'hidden' }}>
        {visible.length === 0 ? (
          <div className="pad empty">
            <div className="ico">◷</div>
            <h2 style={{ marginTop: 10 }}>Aucune proposition pour l&apos;instant</h2>
            <p className="sub" style={{ maxWidth: 460, margin: '6px auto 0' }}>
              Importez un export CSV de vos devis, ou créez une proposition à la main pour essayer.
            </p>
          </div>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>Client</th>
                <th>Proposition</th>
                <th className="num">Montant</th>
                <th>Envoyée</th>
                <th>Silence</th>
                <th>État</th>
                <th>File</th>
                <th>Groupe</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={`/${locale}/pipeline/${r.id}`} style={{ color: 'var(--ink)', fontWeight: 600, textDecoration: 'none' }}>
                      {r.client_name}
                    </a>
                  </td>
                  <td style={{ color: 'var(--ink-2)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.title ?? '—'}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>{eur(Number(r.amount_cents))}</td>
                  <td style={{ color: 'var(--ink-2)' }}>
                    {new Date(r.sent_at).toLocaleDateString('fr-FR')}
                  </td>
                  <td style={{ color: 'var(--ink-2)' }}>{r.daysSinceSend} j</td>
                  <td>
                    <span className={`badge ${r.state}`}>{STATE_FR[r.state]}</span>
                  </td>
                  <td>
                    {r.queueState === 'in_queue' ? (
                      <span className="badge treat">dans la file</span>
                    ) : r.queueState === 'waiting' ? (
                      <span className="badge holdout">à traiter</span>
                    ) : (
                      <span style={{ color: 'var(--ink-3)' }}>—</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${r.arm === 'holdout' ? 'holdout' : 'treat'}`}>
                      {r.arm === 'holdout' ? 'témoin' : 'traité'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <details className="add">
        <summary>+ Créer une proposition à la main</summary>
        <div className="card" style={{ marginTop: 12, maxWidth: 620 }}>
          <div className="pad">
            <OpportunityForm />
          </div>
        </div>
      </details>
    </section>
  );
}
