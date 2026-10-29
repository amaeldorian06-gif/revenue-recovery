import { notFound, redirect } from 'next/navigation';
import { translator, isLocale } from '@rros/i18n';
import { getSession } from '../../../../../lib/session';
import { loadCard, sandboxState } from '../../../../../lib/drafting';
import { DraftCard } from '../../../../../components/DraftCard';
import { CloseWithUndo } from '../../../../../components/CloseWithUndo';
import { lastMessages, type DossierMessage } from '../../../../../lib/actions/dossier';

export const dynamic = 'force-dynamic';

/**
 * The expanded card: one screen, no modal, no navigation inside the flow.
 * Everything the user needs to decide is on the left; everything they send is on
 * the right.
 */
export default async function QueueCardPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  if (!isLocale(locale)) redirect('/fr');
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const tr = translator(locale);

  const card = await loadCard(session, id).catch(() => null);
  if (!card) notFound();
  const sandbox = await sandboxState(session);
  const messages: DossierMessage[] = await lastMessages(id);

  const fr = locale === 'fr';
  const today = new Date().toLocaleDateString(fr ? 'fr-FR' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, margin: '20px 0 12px' }}>
        <div>
          <a href={`/${locale}`} style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            ← {fr ? 'File du jour' : "Today's queue"}
          </a>
          <h2 style={{ margin: '4px 0 0' }}>
            {card.opportunity.clientName}
          </h2>
          <p className="sub" style={{ margin: 0 }}>
            {card.opportunity.title ?? (fr ? 'Sans objet renseigné' : 'No object recorded')} ·{' '}
            {fr ? 'rang' : 'rank'} {card.item.rank} · <span style={{ textTransform: 'capitalize' }}>{today}</span>
          </p>
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', textAlign: 'right' }}>
          <div>{tr('today.trial')}</div>
          <div style={{ marginTop: 2 }}>
            {fr ? 'contacte' : 'contact'}{' '}
            <strong style={{ color: 'var(--ink-2)' }}>{card.opportunity.contactEmail ?? '—'}</strong>
          </div>
        </div>
      </div>

      <DraftCard
        locale={locale}
        item={card.item}
        draft={card.draft}
        opportunity={card.opportunity}
        sandbox={sandbox.sandbox}
      />

      {card.opportunity.replyReceivedAt && (
        <div
          data-testid="reply-badge"
          style={{
            display: 'inline-block', marginTop: 14, padding: '5px 12px', borderRadius: 99,
            background: '#e7f6ef', color: '#067647', fontWeight: 600, fontSize: 12.5,
          }}
        >
          {fr ? 'Réponse reçue — la séquence est arrêtée' : 'Reply received — the sequence stopped'}
        </div>
      )}

      {messages.length > 0 && (
        <div style={{ marginTop: 14 }} data-testid="recent-messages">
          {messages.map((m) => (
            <div className="card" key={m.id} style={{ marginBottom: 10 }}>
              <div className="pad">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, color: 'var(--ink-2)' }}>
                  <strong style={{ color: 'var(--ink)' }}>
                    {m.direction === 'in' ? '←' : '→'} {m.fromEmail}
                  </strong>
                  <span>{m.sentAt.toLocaleDateString(fr ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{m.subject || '—'}</div>
                <p style={{ fontSize: 13, margin: '6px 0 0', color: 'var(--ink-2)' }} data-testid={`snippet-${m.direction}`}>
                  {m.snippet.slice(0, 160)}{m.snippet.length > 160 ? '…' : ''}
                </p>
                {m.isBounce && (
                  <p style={{ fontSize: 12, color: '#b42318', fontWeight: 600, marginTop: 6 }}>
                    {fr ? 'Message d’échec de livraison détecté' : 'Delivery failure detected'}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* One-click decision, only meaningful once a reply exists. */}
      {card.opportunity.replyReceivedAt && (
        <CloseWithUndo locale={locale} opportunityId={id} />
      )}

      <p style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 12 }}>
        {fr
          ? 'Un clic approuve. Le job envoie au prochain passage, après revalidation : c’est ce qui rend un double clic inoffensif.'
          : 'One click approves. The job sends on its next run, after revalidation: that is what makes a double click harmless.'}
      </p>
    </section>
  );
}
