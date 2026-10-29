import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../lib/session';
import { asAdmin } from '../../../../lib/db';
import { isPlatformAdmin } from '../../../../lib/licensing';
import { confirmPaymentAction, rejectPaymentAction, suspendAction, reactivateAction } from '../../../../lib/actions/licensing';

export const dynamic = 'force-dynamic';

/**
 * /admin/licenses — platform-admin only. Pending declarations, the confirm /
 * reject / suspend / reactivate controls, and the recent audit trail. The
 * authorization is a database fact checked here on every render; a hidden URL
 * proves nothing and a workspace 'admin' role proves even less.
 */
export default async function AdminLicensesPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) redirect('/fr');
  const fr = raw === 'fr';
  const { error, done } = await searchParams;
  const session = await getSession();
  if (!session) redirect(`/${raw}/login`);
  if (!(await isPlatformAdmin(session.userId))) redirect(`/${raw}`);

  const data = await asAdmin(async (db) => {
    const pending = await db.query<{
      id: string; workspace_id: string; workspace_name: string; plan: string;
      amount_cents: string; currency: string; payment_method: string;
      external_reference: string | null; submitted_by_email: string; created_at: string;
    }>(
      `select p.id, p.workspace_id, w.name as workspace_name, p.plan::text as plan,
              p.amount_cents::text, p.currency::text, p.payment_method::text,
              p.external_reference, u.email as submitted_by_email, p.created_at::text
         from payments p
         join workspaces w on w.id = p.workspace_id
         join users u on u.id = p.submitted_by
        where p.status = 'pending'
        order by p.created_at asc limit 50`,
    );
    const subs = await db.query<{
      workspace_name: string; workspace_id: string; status: string;
      starts_at: string | null; expires_at: string | null;
    }>(
      `select w.name as workspace_name, s.workspace_id::text, s.status::text as status,
              s.starts_at::text, s.expires_at::text
         from subscriptions s join workspaces w on w.id = s.workspace_id
        where s.product_id = 'revenue_recovery_os'
        order by s.updated_at desc limit 50`,
    );
    const audit = await db.query<{ action: string; created_at: string; after: string | null; workspace_name: string | null }>(
      `select a.action, a.created_at::text, a.after::text, w.name as workspace_name
         from audit_log a left join workspaces w on w.id = a.workspace_id
        where a.action in ('payment.submitted','payment.rejected','subscription.activated',
                           'subscription.renewed','subscription.suspended','subscription.reactivated',
                           'subscription.expired','subscription.requested')
        order by a.created_at desc limit 30`,
    );
    return { pending: pending.rows, subs: subs.rows, audit: audit.rows };
  });

  const methodLabel = (m: string) => ({ bank_transfer: 'Virement', chariow: 'Chariow', maketou: 'Maketou' })[m] ?? m;

  return (
    <section style={{ margin: '22px auto', maxWidth: 900, padding: '0 16px' }} data-testid="admin-licenses">
      <h1>{fr ? 'Licences — vérification manuelle' : 'Licensing — manual verification'}</h1>
      <p className="sub" style={{ fontSize: 13 }}>
        {fr
          ? 'Aucun paiement n’ouvre l’accès avant vérification de la réception réelle des fonds.'
          : 'No payment opens access before the actual receipt of funds is verified.'}
      </p>
      {error && <div className="err" role="alert" data-testid="admin-error">{error}</div>}
      {done && <div className="note" role="status" data-testid="admin-done">{done}</div>}

      <div className="card" style={{ marginTop: 14 }}><div className="pad">
        <strong>{fr ? 'Déclarations en attente' : 'Pending declarations'}</strong>
        {data.pending.length === 0 && <p className="sub" style={{ fontSize: 13 }}>{fr ? 'Aucune déclaration en attente.' : 'Nothing pending.'}</p>}
        {data.pending.map((p) => (
          <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line-2)', fontSize: 13 }} data-testid="pending-row">
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <strong>{p.workspace_name}</strong>
              <span>{p.plan} · {methodLabel(p.payment_method)} · {(Number(p.amount_cents) / (p.currency === 'EUR' ? 100 : 1)).toLocaleString('fr-FR')} {p.currency}</span>
              <span style={{ color: 'var(--ink-3)' }}>
                {p.external_reference ? `réf. ${p.external_reference}` : fr ? 'sans référence' : 'no reference'}
              </span>
              <span style={{ marginLeft: 'auto', color: 'var(--ink-3)', fontSize: 12 }}>{p.submitted_by_email} · {new Date(p.created_at).toLocaleString('fr-FR')}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <form action={confirmPaymentAction}>
                <input type="hidden" name="paymentId" value={p.id} />
                <button className="btn primary" type="submit" data-testid={`confirm-${p.id.slice(0, 8)}`}>
                  {fr ? 'Fonds reçus — confirmer' : 'Funds received — confirm'}
                </button>
              </form>
              <form action={rejectPaymentAction} style={{ display: 'flex', gap: 6 }}>
                <input type="hidden" name="paymentId" value={p.id} />
                <input name="reason" placeholder={fr ? 'motif du rejet' : 'rejection reason'} style={{ padding: '6px 8px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 12.5 }} />
                <button className="btn" type="submit">{fr ? 'Rejeter' : 'Reject'}</button>
              </form>
            </div>
          </div>
        ))}
      </div></div>

      <div className="card" style={{ marginTop: 12 }}><div className="pad" data-testid="subscriptions-list">
        <strong>{fr ? 'Abonnements' : 'Subscriptions'}</strong>
        {data.subs.length === 0 && <p className="sub" style={{ fontSize: 13 }}>—</p>}
        {data.subs.map((s, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--line-2)', flexWrap: 'wrap' }} data-testid="subscription-row">
            <strong>{s.workspace_name}</strong>
            <span style={{
              color: s.status === 'active' ? '#067647' : s.status === 'pending' ? 'var(--ink-2)' : '#b42318',
              fontWeight: 600,
            }}>{s.status}</span>
            <span style={{ color: 'var(--ink-2)' }}>
              {s.expires_at ? new Date(s.expires_at).toLocaleDateString('fr-FR') : '—'}
            </span>
            {s.status === 'active' ? (
              <form action={suspendAction} style={{ marginLeft: 'auto' }}>
                <input type="hidden" name="workspaceId" value={s.workspace_id} />
                <button className="btn" type="submit" data-testid={`suspend-${s.workspace_id.slice(0, 8)}`}>
                  {fr ? 'Suspendre' : 'Suspend'}
                </button>
              </form>
            ) : s.status === 'suspended' ? (
              <form action={reactivateAction} style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <input type="hidden" name="workspaceId" value={s.workspace_id} />
                <input name="months" defaultValue="1" inputMode="numeric" style={{ width: 60, padding: '6px 8px', border: '1px solid var(--line-2)', borderRadius: 8, fontSize: 12.5 }} title={fr ? 'mois à ajouter (0 = aucun)' : 'months to add (0 = none)'} />
                <button className="btn" type="submit" data-testid={`reactivate-${s.workspace_id.slice(0, 8)}`}>
                  {fr ? 'Réactiver' : 'Reactivate'}
                </button>
              </form>
            ) : null}
          </div>
        ))}
      </div></div>

      <div className="card" style={{ marginTop: 12 }}><div className="pad" data-testid="audit-list">
        <strong>{fr ? 'Piste d’audit récente' : 'Recent audit trail'}</strong>
        {data.audit.map((a, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '4px 0', color: 'var(--ink-2)' }}>
            <span style={{ fontFamily: 'monospace' }}>{a.action}</span>
            <span>{a.workspace_name ?? '—'}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--ink-3)' }}>{new Date(a.created_at).toLocaleString('fr-FR')}</span>
          </div>
        ))}
      </div></div>
    </section>
  );
}
