import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../../lib/session';
import { withTenant } from '../../../../../lib/db';
import { classify, topValueThreshold } from '@rros/domain/classify';
import { updateOpportunityAction } from '../../../../../lib/actions/opportunities';

const STATE_FR: Record<string, string> = {
  no_reply: 'Sans réponse',
  late_action: 'Action en retard',
  abnormal_silence: 'Silence anormal',
  watch: 'À surveiller',
};

const REASON_FR: Record<string, (p: Record<string, unknown>) => string> = {
  never_followed_up: (p) => `Envoyée il y a ${p.days} jours, jamais relancée.`,
  overdue_action: (p) => `L'action prévue il y a ${p.days} jours n'a pas eu lieu.`,
  silent_for: (p) => `Aucune interaction depuis ${p.days} jours (seuil de ce stade).`,
  high_value_watch: () => 'Montant dans le top 20 % du portefeuille : à garder à l\'œil, sans urgence.',
  recently_touched: () => 'Rien à signaler : la proposition a été touchée récemment.',
};

const STAGES = [
  ['proposal_sent', 'Proposition envoyée'], ['followup_1', 'Relance 1'], ['followup_2', 'Relance 2'],
  ['followup_3', 'Relance 3'], ['verbal_yes', 'Accord oral'], ['negotiation', 'Négociation'], ['other', 'Autre'],
] as const;

const STATUSES = [
  ['open', 'En cours'], ['won', 'Gagnée'], ['lost', 'Perdue'],
  ['expired', 'Expirée'], ['dormant', 'Dormante'],
] as const;

const dateInput = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
};

const amountInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

export default async function Page({
  params, searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale, id } = await params;
  const { error } = await searchParams;
  if (!isLocale(locale)) return null;
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const res = await withTenant(session.workspaceId, (db) =>
    db.query<{
      id: string; client_name: string; title: string | null; amount_cents: string; stage: string;
      sent_at: string; last_touch_at: string | null; touch_count: number; status: string;
      arm: string; contact_email: string | null; reply_received_at: string | null;
      expected_action_at: string | null; source: string;
    }>(
      `select o.id, o.client_name, o.title, o.amount_cents, o.stage, o.sent_at, o.last_touch_at,
              o.touch_count, o.status, o.arm, c.email as contact_email, o.reply_received_at,
              o.expected_action_at, o.source
         from opportunities o
         left join contacts c on c.id = o.contact_id
        where o.id = $1::uuid and o.workspace_id = $2::uuid`,
      [id, session.workspaceId],
    ),
  );
  const o = res.rows[0];
  if (!o) notFound();

  // A failed send is the customer's business: it is their client who was not
  // reminded. Surface the latest failure with its reason code, in words.
  const failedSend = await withTenant(session.workspaceId, (db) =>
    db.query<{ error_code: string | null; updated_at: string }>(
      `select error_code, updated_at::text from actions
        where opportunity_id = $1::uuid and workspace_id = $2::uuid
          and kind = 'approved' and status = 'failed'
        order by updated_at desc limit 1`,
      [id, session.workspaceId],
    ),
  );
  const lastFailure = failedSend.rows[0] ?? null;

  const openAmounts = await withTenant(session.workspaceId, async (db) => {
    const r = await db.query<{ amount_cents: string }>(
      `select amount_cents from opportunities where workspace_id = $1::uuid and status = 'open'`,
      [session.workspaceId],
    );
    return r.rows.map((x) => Number(x.amount_cents));
  });

  const c = classify({
    amountCents: Number(o.amount_cents), stage: o.stage, sentAt: o.sent_at,
    lastTouchAt: o.last_touch_at, touchCount: o.touch_count, replyReceivedAt: o.reply_received_at,
    status: o.status, expectedActionAt: o.expected_action_at, now: new Date(),
    topValueThresholdCents: topValueThreshold(openAmounts),
  });

  return (
    <section style={{ marginTop: 22, maxWidth: 680 }}>
      <a href={`/${locale}/pipeline`} className="sub" style={{ textDecoration: 'none' }}>
        ← Portefeuille
      </a>
      <h2 style={{ marginTop: 8 }}>{o.client_name}</h2>
      <p className="sub">
        <span className={`badge ${c.state}`}>{STATE_FR[c.state]}</span>{' '}
        <span className={`badge ${o.arm === 'holdout' ? 'holdout' : 'treat'}`}>
          {o.arm === 'holdout' ? 'groupe témoin' : 'traité'}
        </span>{' '}
        · {(REASON_FR[c.reasonKey] ?? (() => 'Dossier suivi.'))(c.params as Record<string, unknown>)}
      </p>

      {lastFailure && (
        <div className="err" role="alert" data-testid="failed-send" style={{ marginTop: 12 }}>
          {locale === 'fr'
            ? `Dernier envoi en échec (raison : ${lastFailure.error_code ?? 'inconnue'}). L'envoi sera retenté automatiquement — jusqu'à 2 fois.`
            : `Last send failed (reason: ${lastFailure.error_code ?? 'unknown'}). It will be retried automatically — up to 2 times.`}
        </div>
      )}

      {o.arm === 'holdout' && (
        <div className="note" style={{ marginTop: 12 }}>
          Cette proposition fait partie du groupe témoin : elle sera suivie et mesurée, mais aucune
          action ne lui sera proposée. Si vous la relancez vous-même, l&apos;écart mesuré ne vaudra
          plus rien pour ce dossier.
        </div>
      )}

      {error === 'invalid' && (
        <div className="err" role="alert">Montant ou date illisible : rien n&apos;a été modifié.</div>
      )}

      <form action={updateOpportunityAction} className="card" style={{ marginTop: 14 }}>
        <div className="pad">
          <input type="hidden" name="id" value={o.id} />
          <div className="row2">
            <div>
              <label className="f" htmlFor="client_name">Client</label>
              <input className="f" id="client_name" name="client_name" defaultValue={o.client_name} required />
            </div>
            <div>
              <label className="f" htmlFor="amount">Montant HT</label>
              <input className="f" id="amount" name="amount" defaultValue={amountInput(Number(o.amount_cents))} required />
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="f" htmlFor="title">Objet</label>
            <input className="f" id="title" name="title" defaultValue={o.title ?? ''} />
          </div>
          <div className="row2" style={{ marginTop: 12 }}>
            <div>
              <label className="f" htmlFor="sent_at">Date d&apos;envoi</label>
              <input className="f" id="sent_at" name="sent_at" defaultValue={dateInput(o.sent_at)} required />
            </div>
            <div>
              <label className="f" htmlFor="stage">Stade</label>
              <select className="f" id="stage" name="stage" defaultValue={o.stage}>
                {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="row2" style={{ marginTop: 12 }}>
            <div>
              <label className="f" htmlFor="status">Statut</label>
              <select className="f" id="status" name="status" defaultValue={o.status}>
                {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="f" htmlFor="contact_email">E-mail du contact</label>
              <input className="f" id="contact_email" name="contact_email" type="email" defaultValue={o.contact_email ?? ''} />
            </div>
          </div>
          <button className="btn primary" type="submit" style={{ marginTop: 14 }}>Enregistrer</button>
          <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>
            Le groupe ({o.arm === 'holdout' ? 'témoin' : 'traité'}) n&apos;est pas modifiable : il a été
            figé à l&apos;import et la base refuse tout changement.
          </p>
        </div>
      </form>
    </section>
  );
}
