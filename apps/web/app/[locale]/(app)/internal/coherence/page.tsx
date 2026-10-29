import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../../lib/session';
import { withTenant } from '../../../../../lib/db';
import { coherenceReport } from '@rros/db/measurement';

export const dynamic = 'force-dynamic';

/**
 * Internal coherence view — not linked anywhere in the customer UI.
 *
 * §10.3: when |B − C − A| exceeds the tolerance, the flag belongs in an internal
 * admin view, never in the customer screen. The customer keeps seeing the raw B
 * and C (we do not hide the numbers); what they never see is our alarm.
 *
 * Access: an explicit allowlist of operator emails. Falling back to "owner in
 * development" keeps the local flow usable without weakening production.
 */
function allowed(email: string, role: string): boolean {
  const list = (process.env.INTERNAL_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (list.length > 0) return list.includes(email.toLowerCase());
  return process.env.NODE_ENV !== 'production' && (role === 'owner' || role === 'admin');
}

const eur = (cents: number) =>
  new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(
    cents / 100,
  );

export default async function CoherencePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) redirect('/fr');
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  if (!allowed(session.email, session.role)) notFound();

  const rows = await withTenant(session.workspaceId, (db) => coherenceReport(db, session.workspaceId));
  const flagged = rows.filter((r) => r.verdict === 'investigate');

  return (
    <section style={{ marginTop: 20 }} data-testid="coherence-admin">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ margin: 0 }}>Cohérence de la mesure</h2>
        <span className="pill" style={{ fontSize: 11.5 }}>
          interne
        </span>
      </div>
      <p className="sub" style={{ margin: '2px 0 14px' }}>
        Contrôle |B − C − A| ≤ 25 % de |A| + 30 €. Une semaine hors tolérance signale une incohérence
        entre le chiffre d’affaires enregistré et l’estimation causale — jamais un problème de calcul.
      </p>

      <div className="card">
        <div className="pad" style={{ paddingTop: 12, paddingBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>
            {flagged.length === 0
              ? `Toutes les semaines sont cohérentes (${rows.length}).`
              : `${flagged.length} semaine${flagged.length > 1 ? 's' : ''} à examiner.`}
          </strong>
        </div>
      </div>

      <div className="card" style={{ marginTop: 12, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-2)' }}>
              {['Workspace', 'Semaine', 'A (causal)', 'B (brut)', 'C (témoin ramené)', '|B − C − A|', 'Verdict'].map((h) => (
                <th key={h} scope="col" style={{ padding: '8px 10px', borderBottom: '1px solid #e4e7ec', fontWeight: 600 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.workspaceId}-${r.weekStart}`}>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f2f4f7' }}>{r.workspaceName}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f2f4f7' }}>{r.weekStart}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{eur(r.estimateCents)}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{eur(r.revenueBCents)}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{eur(r.revenueCCents)}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f2f4f7', fontVariantNumeric: 'tabular-nums' }}>{eur(r.gapCents)}</td>
                <td style={{ padding: '6px 10px', borderBottom: '1px solid #f2f4f7' }}>
                  <strong
                    data-testid={`verdict-${r.weekStart}`}
                    style={{ color: r.verdict === 'investigate' ? '#b42318' : '#067647' }}
                  >
                    {r.verdict === 'investigate' ? 'INCOHÉRENT' : 'OK'}
                  </strong>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: '12px 10px', color: 'var(--ink-3)' }}>
                  Aucune attribution calculée pour ce workspace.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
