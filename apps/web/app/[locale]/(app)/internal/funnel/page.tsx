import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../../lib/session';
import { asAdmin } from '../../../../../lib/db';
import { funnelSummary } from '@rros/db/billing';

export const dynamic = 'force-dynamic';

/**
 * The acquisition funnel, admin-only. Median minutes from signup to first
 * queue is the number the 8-minute promise is judged on; the step counts say
 * where people stop.
 */
export default async function FunnelPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';
  const session = await getSession();
  if (!session) redirect(`/${rawLocale}/login`);

  const profile = await asAdmin((db) =>
    db.query<{ email: string; role: string }>('select email, role from users where id = $1::uuid', [session.userId]),
  );
  const email = profile.rows[0]?.email ?? '';
  const role = profile.rows[0]?.role ?? 'member';
  const list = (process.env.INTERNAL_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  const allowed = list.length > 0
    ? list.includes(email.toLowerCase())
    : process.env.NODE_ENV !== 'production' && (role === 'owner' || role === 'admin');
  if (!allowed) redirect(`/${rawLocale}`);

  const steps = await asAdmin((db) => funnelSummary(db));
  const max = Math.max(1, ...steps.map((s) => s.count));

  return (
    <section style={{ maxWidth: 720, margin: '0 auto' }} data-testid="funnel-admin">
      <h2>{fr ? 'Tunnel d’activation' : 'Activation funnel'}</h2>
      <p className="sub">
        {fr
          ? 'Promesse : inscription → première file en moins de 8 minutes. La médiane est la vérité ; la moyenne flatte les cas extrêmes.'
          : 'Promise: signup → first queue in under 8 minutes. The median is the truth; the average flatters the extremes.'}
      </p>
      <div className="card" style={{ marginTop: 14 }}><div className="pad">
        {steps.map((s) => (
          <div key={s.name} data-testid={`funnel-${s.name}`} style={{ padding: '10px 0', borderBottom: '1px solid var(--line-2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
              <strong>{s.name}</strong>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{s.count}</span>
            </div>
            <div style={{ height: 5, background: '#eef0f3', borderRadius: 99, marginTop: 6 }}>
              <div style={{ height: 5, borderRadius: 99, background: 'var(--accent)', width: `${(s.count / max) * 100}%` }} />
            </div>
            {s.medianMinutes !== null && (
              <p className="sub" style={{ fontSize: 12.5, marginTop: 6 }}>
                {fr ? `Médiane inscription → première file : ${String(s.medianMinutes).replace('.', ',')} min` : `Median signup → first queue: ${s.medianMinutes} min`}
              </p>
            )}
          </div>
        ))}
      </div></div>
    </section>
  );
}
