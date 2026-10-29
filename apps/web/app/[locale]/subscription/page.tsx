import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../lib/session';
import { asAdmin } from '../../../lib/db';
import { getEntitlement } from '../../../lib/licensing';
import { submitDeclarationAction } from '../../../lib/actions/licensing';
import { PLANS } from '@rros/domain/entitlements';

/** Private or tokenized page: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export const dynamic = 'force-dynamic';

/**
 * The manual-payment page: plan, price, how to pay (bank / Chariow / Maketou),
 * the declaration form, the payment history and the current entitlement. No
 * online checkout by design — the money moves outside the app, and this page
 * says "pending" until an administrator has verified the receipt.
 */
export default async function SubscriptionPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) redirect('/fr');
  const fr = raw === 'fr';
  const { error, sent } = await searchParams;
  const session = await getSession();
  if (!session) redirect(`/${raw}/login`);

  const ent = await getEntitlement(session);
  const history = await asAdmin((db) =>
    db.query<{ id: string; plan: string; amount_cents: string; currency: string; payment_method: string;
               status: string; external_reference: string | null; rejection_reason: string | null; created_at: string }>(
      `select id, plan::text as plan, amount_cents::text, currency::text, payment_method::text,
              status::text, external_reference, rejection_reason, created_at::text
         from payments where workspace_id = $1::uuid order by created_at desc limit 20`,
      [session.workspaceId],
    ),
  );
  const payments = history.rows;
  const bankDetails = process.env.PAYMENT_BANK_DETAILS ?? 'IBAN communiqué par e-mail après demande';
  const chariowUrl = process.env.PAYMENT_CHARIOW_URL ?? '';
  const maketouUrl = process.env.PAYMENT_MAKETOU_URL ?? '';

  const statusLabel = (s: string) =>
    fr
      ? { pending: 'En vérification', confirmed: 'Confirmé', rejected: 'Rejeté', refunded: 'Remboursé' }[s] ?? s
      : { pending: 'Pending review', confirmed: 'Confirmed', rejected: 'Rejected', refunded: 'Refunded' }[s] ?? s;

  const methodLabel = (m: string) =>
    fr ? { bank_transfer: 'Virement', chariow: 'Chariow', maketou: 'Maketou' }[m] ?? m
       : { bank_transfer: 'Bank transfer', chariow: 'Chariow', maketou: 'Maketou' }[m] ?? m;

  const allowedSentence = fr
    ? `Accès actif${ent.expiresAt ? ` — expire le ${new Date(ent.expiresAt).toLocaleDateString('fr-FR')}` : ''} (${ent.status === 'trial' ? 'période d’essai' : 'abonnement confirmé'}).`
    : `Access active${ent.expiresAt ? ` — expires ${new Date(ent.expiresAt).toLocaleDateString('en-GB')}` : ''} (${ent.status === 'trial' ? 'trial' : 'confirmed subscription'}).`;
  const FR_REASONS: Record<string, string> = {
    no_subscription: 'Aucun abonnement pour cet espace. Choisissez un palier et soumettez votre déclaration de paiement.',
    pending: 'Votre première déclaration est en vérification : l’accès s’ouvrira dès confirmation du paiement par notre équipe.',
    expired: 'Votre abonnement a expiré. Pour reprendre, réglez le mois suivant — l’accès revient dès confirmation.',
    suspended: 'Accès suspendu par l’équipe. Contactez-nous avant tout nouveau paiement.',
    cancelled: 'Abonnement annulé.',
    product_disabled: 'Produit temporairement indisponible.',
    not_started: 'Abonnement pas encore actif : sa période de validité n’a pas commencé.',
  };
  const EN_REASONS: Record<string, string> = {
    no_subscription: 'No subscription for this workspace yet. Pick a plan and submit your payment declaration.',
    pending: 'Your declaration is under review: access opens as soon as our team confirms the payment.',
    expired: 'Your subscription has expired. Pay the next month to resume — access returns on confirmation.',
    suspended: 'Access suspended by our team. Contact us before any new payment.',
    cancelled: 'Subscription cancelled.',
    product_disabled: 'Product temporarily unavailable.',
    not_started: 'Subscription not started yet: its validity period has not begun.',
  };
  const blockedSentence = (fr ? FR_REASONS : EN_REASONS)[ent.reasonCode] ?? (fr ? 'Accès restreint.' : 'Access restricted.');
  const stateSentence = ent.accessAllowed ? allowedSentence : blockedSentence;


  return (
    <section style={{ margin: '22px auto', maxWidth: 760, padding: '0 16px' }} data-testid="subscription-page">
      <h1>{fr ? 'Abonnement & paiement' : 'Subscription & payment'}</h1>
      <p className="sub" style={{ fontSize: 13.5 }} data-testid="entitlement-state">
        {stateSentence}
      </p>

      {sent === '1' && (
        <div className="note" role="status" data-testid="declaration-sent">
          {fr ? 'Déclaration reçue — elle reste « en vérification » jusqu’à confirmation du paiement par notre équipe.' : 'Declaration received — it stays "pending" until our team confirms the payment.'}
        </div>
      )}
      {error === 'duplicate_reference' && (
        <div className="err" role="alert">{fr ? 'Cette référence de transaction a déjà été déclarée.' : 'This transaction reference was already declared.'}</div>
      )}
      {error === 'bad_amount' && <div className="err" role="alert">{fr ? 'Montant invalide.' : 'Invalid amount.'}</div>}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginTop: 14 }}>
        {(Object.keys(PLANS) as Array<keyof typeof PLANS>).map((key) => {
          const p = PLANS[key];
          const current = session && ent.accessAllowed && ent.status === 'active';
          return (
            <div className="card" key={key} data-testid={`plan-${key}`} style={current ? { borderColor: 'var(--accent)' } : undefined}>
              <div className="pad">
                <strong style={{ textTransform: 'capitalize' }}>{key}</strong>
                <div style={{ fontSize: 22, fontWeight: 680, margin: '6px 0' }}>{p.priceMonthlyEur} €<span className="sub" style={{ fontSize: 12 }}>/{fr ? 'mois' : 'mo'}</span></div>
                <p className="sub" style={{ fontSize: 12.5 }}>
                  {p.proposalsPerMonth} {fr ? 'propositions suivies' : 'proposals'} · {p.seats} {fr ? 'siège(s)' : 'seat(s)'} · API {p.api === 'none' ? (fr ? 'non' : 'no') : p.api}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ marginTop: 14 }}><div className="pad">
        <strong>{fr ? 'Comment payer' : 'How to pay'}</strong>
        <ol style={{ fontSize: 13.5, lineHeight: 1.7, paddingLeft: 18 }}>
          <li>{fr ? <>Virement bancaire — {bankDetails}</> : <>Bank transfer — {bankDetails}</>}</li>
          {chariowUrl && <li>Chariow : <a href={chariowUrl} rel="noreferrer">{chariowUrl}</a></li>}
          {maketouUrl && <li>Maketou : <a href={maketouUrl} rel="noreferrer">{maketouUrl}</a></li>}
          <li>{fr ? 'Déclarez votre paiement ci-dessous (référence exacte de la transaction).' : 'Declare your payment below (exact transaction reference).'}</li>
          <li>{fr ? 'Notre équipe vérifie la réception réelle des fonds, puis active votre mois.' : 'Our team verifies the funds actually received, then activates your month.'}</li>
        </ol>

        <form action={submitDeclarationAction} style={{ display: 'grid', gap: 8, marginTop: 10, maxWidth: 460 }} data-testid="declaration-form">
          <label className="f" htmlFor="plan">{fr ? 'Palier' : 'Plan'}</label>
          <select className="f" id="plan" name="plan" defaultValue="growth">
            {(Object.keys(PLANS) as Array<keyof typeof PLANS>).map((k) => (
              <option key={k} value={k}>{k} — {PLANS[k].priceMonthlyEur} €</option>
            ))}
          </select>
          <div className="row2">
            <div>
              <label className="f" htmlFor="currency">{fr ? 'Devise' : 'Currency'}</label>
              <select className="f" id="currency" name="currency" defaultValue="EUR">
                <option value="EUR">EUR</option>
                <option value="XAF">XAF</option>
              </select>
            </div>
            <div>
              <label className="f" htmlFor="amount">{fr ? 'Montant payé' : 'Amount paid'}</label>
              <input className="f" id="amount" name="amount" required inputMode="decimal" placeholder={fr ? 'ex. 699 ou 458 513' : 'e.g. 699'} />
            </div>
          </div>
          <label className="f" htmlFor="payment_method">{fr ? 'Moyen de paiement' : 'Payment method'}</label>
          <select className="f" id="payment_method" name="payment_method" defaultValue="bank_transfer">
            <option value="bank_transfer">{fr ? 'Virement bancaire' : 'Bank transfer'}</option>
            <option value="chariow">Chariow</option>
            <option value="maketou">Maketou</option>
          </select>
          <label className="f" htmlFor="external_reference">{fr ? 'Référence de la transaction' : 'Transaction reference'}</label>
          <input className="f" id="external_reference" name="external_reference" placeholder={fr ? 'ex. TR-1234567890 ou id Chariow' : 'e.g. TR-1234567890'} />
          <button className="btn primary" type="submit" style={{ marginTop: 6 }} data-testid="declaration-submit">
            {fr ? 'Déclarer ce paiement' : 'Declare this payment'}
          </button>
          <p className="sub" style={{ fontSize: 12 }}>
            {fr ? 'Une déclaration n’ouvre pas l’accès : seul le paiement réellement reçu et vérifié le fait.' : 'A declaration does not open access: only a verified, actually received payment does.'}
          </p>
        </form>
      </div></div>

      <div className="card" style={{ marginTop: 14 }}><div className="pad" data-testid="payment-history">
        <strong>{fr ? 'Mes paiements' : 'My payments'}</strong>
        {payments.length === 0 && <p className="sub" style={{ fontSize: 13 }}>{fr ? 'Aucune déclaration pour l’instant.' : 'No declaration yet.'}</p>}
        {payments.map((p) => (
          <div key={p.id} style={{ display: 'flex', gap: 10, fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--line-2)' }} data-testid="payment-row">
            <span>{methodLabel(p.payment_method)}</span>
            <span>{(Number(p.amount_cents) / (p.currency === 'EUR' ? 100 : 1)).toLocaleString(fr ? 'fr-FR' : 'en-GB')} {p.currency}</span>
            <span style={{ color: p.status === 'confirmed' ? '#067647' : p.status === 'rejected' ? '#b42318' : 'var(--ink-2)' }}>
              {statusLabel(p.status)}
            </span>
            <span style={{ marginLeft: 'auto', color: 'var(--ink-3)', fontSize: 12 }}>
              {new Date(p.created_at).toLocaleDateString(fr ? 'fr-FR' : 'en-GB')}
              {p.rejection_reason ? ` · ${p.rejection_reason}` : ''}
            </span>
          </div>
        ))}
      </div></div>
    </section>
  );
}
