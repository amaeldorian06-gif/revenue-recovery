import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../lib/session';
import { asAdmin } from '../../../../lib/db';
import { lastRuns, staleJobs } from '@rros/db/jobs';

export const dynamic = 'force-dynamic';

/**
 * /admin/ops — admin-only operating picture: cron heartbeats, webhook failure
 * rate, per-route API p95. Numbers, not contents.
 */
export default async function OpsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';
  const session = await getSession();
  if (!session) redirect(`/${rawLocale}/login`);
  if (session.role !== 'owner' && session.role !== 'admin') redirect(`/${rawLocale}`);

  const data = await asAdmin(async (db) => {
    const runs = await lastRuns(db);
    const webhooks = await db.query<{ total: number; failed: number; dead: number }>(
      `select count(*)::int as total,
              count(*) filter (where last_status_code >= 500 or last_error is not null)::int as failed,
              count(*) filter (where status = 'dead')::int as dead
         from webhook_deliveries`,
    );
    const p95 = await db.query<{ route: string; p95: number; n: number }>(
      `select route, percentile_cont(0.95) within group (order by duration_ms)::int as p95,
              count(*)::int as n
         from api_requests
        where duration_ms > 0
        group by route order by route`,
    );
    const workspaces = await db.query<{ n: number }>('select count(*)::int as n from workspaces where deleted_at is null');
    // Failed sends, by reason code: "to us" means aggregate + code, never the body.
    const failedSends = await db.query<{ error_code: string | null; n: number }>(
      `select error_code, count(*)::int as n
         from actions
        where kind = 'approved' and status = 'failed'
        group by error_code order by n desc limit 10`,
    );
    return { runs, alerts: staleJobs(runs), webhooks: webhooks.rows[0]!, p95: p95.rows, workspaces: workspaces.rows[0]!.n, failedSends: failedSends.rows };
  });

  return (
    <section style={{ margin: '22px auto', maxWidth: 860, padding: '0 16px' }} data-testid="ops-page">
      <h1>{fr ? 'Exploitation' : 'Operations'}</h1>
      <p className="sub" style={{ fontSize: 13 }}>
        {fr ? 'Admin seulement. Des chiffres, jamais de contenus.' : 'Admin only. Numbers, never contents.'}
      </p>

      <div className="card" style={{ marginTop: 14 }}><div className="pad">
        <strong>{fr ? 'Crons (battements)' : 'Cron heartbeats'}</strong>
        {data.alerts.length > 0 && (
          <p data-testid="ops-alerts" style={{ color: '#b42318', fontWeight: 600, fontSize: 13 }}>
            {fr ? 'Retards détectés :' : 'Overdue jobs:'}{' '}
            {data.alerts.map((a) => `${a.job} (+${Math.round(a.overdueByS / 60)} min)`).join(', ')}
          </p>
        )}
        {data.runs.length === 0 && <p className="sub" style={{ fontSize: 13 }}>{fr ? 'Aucun cron exécuté pour l’instant.' : 'No cron has run yet.'}</p>}
        {data.runs.map((r) => (
          <div key={r.job} style={{ display: 'flex', gap: 10, fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--line-2)' }}>
            <span style={{ fontFamily: 'monospace' }}>{r.job}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ink-2)' }}>
              {r.lastOkAt ? r.lastOkAt.toLocaleString(fr ? 'fr-FR' : 'en-GB') : '—'}
            </span>
          </div>
        ))}
      </div></div>

      <div className="card" style={{ marginTop: 12 }}><div className="pad">
        <strong>{fr ? 'Webhooks' : 'Webhooks'}</strong>
        <p style={{ fontSize: 13.5 }}>
          {fr ? 'Échecs' : 'Failures'} {data.webhooks.failed}/{data.webhooks.total} ·{' '}
          {fr ? 'lettres mortes' : 'dead letters'} {data.webhooks.dead}
        </p>
      </div></div>

      <div className="card" style={{ marginTop: 12 }}><div className="pad">
        <strong>{fr ? 'Envois en échec (par raison)' : 'Failed sends (by reason)'}</strong>
        {data.failedSends.length === 0 && <p className="sub" style={{ fontSize: 13 }}>{fr ? 'Aucun envoi en échec.' : 'No failed sends.'}</p>}
        {data.failedSends.map((r) => (
          <div key={r.error_code ?? 'unknown'} style={{ display: 'flex', gap: 10, fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--line-2)' }} data-testid="ops-failed-sends">
            <span style={{ fontFamily: 'monospace' }}>{r.error_code ?? 'UNKNOWN'}</span>
            <span style={{ marginLeft: 'auto' }}>{r.n}</span>
          </div>
        ))}
      </div></div>

      <div className="card" style={{ marginTop: 12 }}><div className="pad">
        <strong>{fr ? 'API v1 — p95 par route' : 'API v1 — p95 per route'}</strong>
        {data.p95.length === 0 && <p className="sub" style={{ fontSize: 13 }}>{fr ? 'Pas encore de trafic API.' : 'No API traffic yet.'}</p>}
        {data.p95.map((r) => (
          <div key={r.route} style={{ display: 'flex', gap: 10, fontSize: 13, padding: '5px 0', borderBottom: '1px solid var(--line-2)' }}>
            <span style={{ fontFamily: 'monospace' }}>{r.route}</span>
            <span style={{ marginLeft: 'auto' }}>{r.p95} ms · {r.n} {fr ? 'appels' : 'calls'}</span>
          </div>
        ))}
        <p className="sub" style={{ fontSize: 12 }}>
          {fr ? 'Espaces de travail actifs :' : 'Active workspaces:'} {data.workspaces}
        </p>
      </div></div>
    </section>
  );
}
