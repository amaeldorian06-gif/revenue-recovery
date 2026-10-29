'use client';

import { useCallback, useMemo, useState } from 'react';
import type { QueueItemView } from '@rros/db/queue';
import { whyNow, topSentences, formulaLines } from '@rros/domain/scoring/explanations';
import type { DraftState, Tone } from '../lib/drafting';
import type { Locale } from '@rros/domain/drafting/context';

const EUR = (locale: Locale) => (cents: number) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(cents / 100);

const PCT = (n: number) => `${Math.round(n * 100)} %`;

const TONES: Array<{ id: Tone; fr: string; en: string; hint: string }> = [
  { id: 'warm', fr: 'Chaleureux', en: 'Warm', hint: 'proximité' },
  { id: 'direct', fr: 'Direct', en: 'Direct', hint: 'factuel' },
  { id: 'formal', fr: 'Formel', en: 'Formal', hint: 'vouvoiement tenu' },
];

const DISMISS_REASONS = [
  { id: 'not_relevant', fr: 'Plus d’actualité', en: 'No longer relevant' },
  { id: 'already_answered_elsewhere', fr: 'Déjà répondu ailleurs', en: 'Answered elsewhere' },
  { id: 'client_asked_to_stop', fr: 'Le client demande d’arrêter', en: 'Client asked to stop' },
  { id: 'other', fr: 'Autre raison', en: 'Other reason' },
] as const;

type Mode = 'idle' | 'working' | 'approved' | 'snoozed' | 'dismissed';

interface Props {
  locale: Locale;
  item: QueueItemView;
  draft: DraftState;
  opportunity: {
    clientName: string;
    title: string | null;
    amountCents: number;
    sentAt: string;
    touchCount: number;
    contactEmail: string | null;
    contactFirstName: string | null;
  };
  sandbox: boolean;
  /** Counts the card as handled, for the optimistic progress bar. */
  onHandled?: (kind: 'approved' | 'snoozed' | 'dismissed', nextFollowUpAt?: string) => void;
}

const fmtDate = (locale: Locale, iso: string) =>
  new Date(iso).toLocaleDateString(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  });

export function DraftCard({ locale, item, draft, opportunity, sandbox, onHandled }: Props) {
  const fr = locale === 'fr';
  const eur = useMemo(() => EUR(locale), [locale]);

  const [actionId, setActionId] = useState<string | null>(draft.actionId);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [tone, setTone] = useState<Tone>(draft.tone);
  const [manual, setManual] = useState(draft.manual);
  // A dossier that already left the draft state opens read-only: the flow shows
  // what happened, and never offers to send a second message by accident.
  const initialMode: Mode =
    draft.status === 'sent' || draft.status === 'approved' ? 'approved'
    : draft.status === 'deferred' ? 'snoozed'
    : draft.status === 'dismissed' || draft.status === 'cancelled' ? 'dismissed'
    : 'idle';
  const [mode, setMode] = useState<Mode>(initialMode);
  const readOnly = draft.status !== 'draft';
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingTone, setPendingTone] = useState<Tone | null>(null);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [nextFollowUp, setNextFollowUp] = useState<string | null>(null);

  const initialBody = draft.body;
  const edited = body.trim() !== initialBody.trim();
  const days = Math.max(0, Math.floor((Date.now() - new Date(item.sentAt).getTime()) / 86_400_000));

  const [expectedLine, priorityLine] = formulaLines(
    {
      amountCents: item.amountCents,
      pReply: item.pReply,
      pConvert: item.pConvert,
      urgency: item.urgency,
      expectedValueCents: item.expectedValueCents,
    },
    item.priorityIndex,
    locale,
  );

  const post = useCallback(async (url: string, payload: unknown) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? res.status));
    return json;
  }, []);

  const approve = useCallback(async () => {
    if (!actionId) return;
    setMode('working');
    setError(null);
    try {
      const json = await post(`/api/actions/${actionId}/approve`, { finalText: body, subject });
      const next = String(json.nextFollowUpAt ?? '');
      setNextFollowUp(next);
      setMode('approved');
      setToast(
        fr
          ? `Approuvé. Envoi au prochain passage du job — prochaine relance le ${fmtDate(locale, next)}.`
          : `Approved. Sent on the next job run — next follow-up on ${fmtDate(locale, next)}.`,
      );
      onHandled?.('approved', next);
    } catch (err) {
      setMode('idle');
      setError(
        fr ? 'Approbation impossible. Réessayez.' : 'Approval failed. Try again.',
      );
      void err;
    }
  }, [actionId, body, subject, fr, locale, onHandled, post]);

  const snooze = useCallback(async () => {
    if (!actionId) return;
    setMode('working');
    try {
      const json = await post(`/api/actions/${actionId}/snooze`, { days: 7 });
      const until = String(json.until ?? '');
      setNextFollowUp(until);
      setMode('snoozed');
      setToast(
        fr ? `Reporté au ${fmtDate(locale, until)}. Aucun contact entre-temps.`
           : `Snoozed until ${fmtDate(locale, until)}. No contact in between.`,
      );
      onHandled?.('snoozed', until);
    } catch {
      setMode('idle');
      setError(fr ? 'Report impossible.' : 'Snooze failed.');
    }
  }, [actionId, fr, locale, onHandled, post]);

  const dismiss = useCallback(
    async (reason: string) => {
      if (!actionId) return;
      setMode('working');
      try {
        await post(`/api/actions/${actionId}/dismiss`, { reason });
        setMode('dismissed');
        setDismissOpen(false);
        setToast(
          reason === 'client_asked_to_stop'
            ? (fr ? 'Dossier clos. Le contact ne sera plus jamais relancé.' : 'Dossier closed. This contact will never be followed up again.')
            : reason === 'not_relevant'
            ? (fr ? 'Dossier classé sans suite.' : 'Dossier closed as dormant.')
            : (fr ? 'Dossier écarté.' : 'Dossier dismissed.'),
        );
        onHandled?.('dismissed');
      } catch {
        setMode('idle');
        setError(fr ? 'Impossible d’écarter ce dossier.' : 'Could not dismiss this dossier.');
      }
    },
    [actionId, fr, onHandled, post],
  );

  const switchTone = useCallback(
    async (next: Tone) => {
      setPendingTone(null);
      setMode('working');
      setError(null);
      try {
        const json = await post('/api/drafts/generate', { opportunityId: item.opportunityId, tone: next });
        const created = json.draft as { actionId: string; subject: string; body: string } | null;
        if (!created) {
          setMode('idle');
          setError(
            fr
              ? 'Pas de brouillon disponible pour ce ton — écrivez ce message vous-même.'
              : 'No draft available in this tone — write it yourself.',
          );
          return;
        }
        setActionId(created.actionId);
        setSubject(created.subject);
        setBody(created.body);
        setTone(next);
        setManual(false);
        setMode('idle');
        setToast(fr ? 'Brouillon régénéré.' : 'Draft regenerated.');
      } catch {
        setMode('idle');
        setError(fr ? 'Régénération impossible.' : 'Regeneration failed.');
      }
    },
    [fr, item.opportunityId, post],
  );

  const onToneClick = (next: Tone) => {
    if (next === tone) return;
    if (edited) setPendingTone(next);
    else void switchTone(next);
  };

  const done = mode === 'approved' || mode === 'snoozed' || mode === 'dismissed';

  return (
    <div
      data-testid="draft-card"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(240px, 0.85fr) minmax(380px, 1.15fr)',
        gap: 0,
        border: '1px solid var(--line-2)',
        borderRadius: 14,
        background: '#fff',
        overflow: 'hidden',
        opacity: done ? 0.55 : 1,
        transform: done ? 'translateY(-4px)' : 'none',
        transition: 'opacity .45s ease, transform .45s ease',
      }}
    >
      {/* ---------------------------------------------------------- left: why */}
      <aside
        style={{
          padding: '16px 16px 18px',
          borderRight: '1px solid var(--line-2)',
          background: 'linear-gradient(180deg,#fcfdfe,#f8fafb)',
        }}
      >
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span
            style={{
              minWidth: 44, height: 34, borderRadius: 9, display: 'grid', placeItems: 'center',
              fontWeight: 700, fontSize: 15, fontVariantNumeric: 'tabular-nums',
              background: item.priorityIndex >= 70 ? '#fef3f2' : '#f2f4f7',
              color: item.priorityIndex >= 70 ? '#b42318' : '#475467',
            }}
            aria-label={fr ? `Priorité ${item.priorityIndex} sur 100` : `Priority ${item.priorityIndex} out of 100`}
          >
            {item.priorityIndex}
          </span>
          <div>
            <div style={{ fontWeight: 640, fontSize: 14 }}>
              {opportunity.clientName}{' '}
              <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>
                {eur(opportunity.amountCents)}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              {opportunity.title ?? '—'} · {fr ? `${days} j sans réponse` : `${days} d unanswered`}
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
          {[
            { label: fr ? 'valeur attendue' : 'expected', v: eur(item.expectedValueCents), raw: Math.min(1, item.expectedValueCents / Math.max(1, item.amountCents)) },
            { label: 'p(réponse)', v: PCT(item.pReply), raw: item.pReply },
            { label: 'p(conversion)', v: PCT(item.pConvert), raw: item.pConvert },
            { label: fr ? 'urgence' : 'urgency', v: item.urgency.toFixed(2), raw: item.urgency },
          ].map((m) => (
            <div key={m.label}>
              <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--ink-3)', fontWeight: 600 }}>
                {m.label}
              </div>
              <div style={{ fontSize: 14.5, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{m.v}</div>
              <div style={{ height: 4, background: '#eef0f3', borderRadius: 99, marginTop: 4 }}>
                <div style={{ height: 4, width: `${Math.round(m.raw * 100)}%`, background: 'var(--accent)', borderRadius: 99 }} />
              </div>
            </div>
          ))}
        </div>

        <p style={{ margin: '14px 0 0', fontSize: 12.5, color: 'var(--ink-2)' }}>
          {whyNow(item.factors, locale)}
        </p>
        <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 11.5, color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {topSentences(item.factors, locale).slice(0, 3).map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>

        <pre
          style={{
            marginTop: 12, marginBottom: 0, background: '#0f172a', color: '#e2e8f0',
            padding: '8px 10px', borderRadius: 8, fontSize: 10.5, lineHeight: 1.65,
            fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', overflowX: 'auto',
          }}
        >
{expectedLine}
{'\n'}{priorityLine}
        </pre>

        <p style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 8 }}>
          {fr
            ? `moteur ${item.engineVersion} · priorité relative, pas une probabilité`
            : `engine ${item.engineVersion} · relative priority, not a probability`}
        </p>
      </aside>

      {/* ------------------------------------------------------- right: editor */}
      <section style={{ padding: '16px 18px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {readOnly && (
          <div
            data-testid="readonly-banner"
            style={{
              border: '1px solid var(--line-2)', background: '#f8fafb', borderRadius: 9,
              padding: '9px 11px', fontSize: 12.5, color: 'var(--ink-2)',
            }}
          >
            <strong style={{ color: 'var(--ink)' }}>
              {draft.status === 'sent'
                ? (fr ? 'Message envoyé' : 'Message sent')
                : draft.status === 'approved'
                ? (fr ? 'Approuvé — en attente du job d’envoi' : 'Approved — waiting for the send job')
                : draft.status === 'deferred'
                ? (fr ? 'Dossier reporté' : 'Dossier snoozed')
                : draft.status === 'cancelled'
                ? (fr ? 'Envoi annulé par une règle d’arrêt' : 'Send cancelled by a stop rule')
                : (fr ? 'Dossier écarté' : 'Dossier dismissed')}
            </strong>
            {draft.at && (
              <span>
                {' · '}
                {new Date(draft.at).toLocaleDateString(fr ? 'fr-FR' : 'en-GB', {
                  day: 'numeric', month: 'long',
                })}
                {draft.reason ? ` · ${draft.reason}` : ''}
              </span>
            )}
            <div style={{ marginTop: 3, fontSize: 11.5 }}>
              {fr
                ? 'Ce dossier ne recevra pas d’autre message aujourd’hui.'
                : 'This dossier will not receive another message today.'}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
            {fr ? 'Brouillon de relance' : 'Follow-up draft'}
            {draft.model && (
              <span style={{ marginLeft: 6, fontFamily: 'ui-monospace,monospace' }}>
                {draft.model} · {draft.promptVersion}
              </span>
            )}
          </div>
          <div role="group" aria-label={fr ? 'Ton du message' : 'Message tone'} style={{ display: 'flex', gap: 6 }}>
            {TONES.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`tone-${t.id}`}
                aria-pressed={tone === t.id}
                onClick={() => onToneClick(t.id)}
                className={tone === t.id ? 'btn primary' : 'btn'}
                style={{ padding: '4px 10px', fontSize: 11.5, borderRadius: 99 }}
              >
                {fr ? t.fr : t.en}
              </button>
            ))}
          </div>
        </div>

        {manual && (
          <div
            data-testid="manual-notice"
            style={{
              border: '1px solid #fde3c4', background: '#fffbf3', borderRadius: 9,
              padding: '9px 11px', fontSize: 12.5, color: '#7a4a06',
            }}
          >
            <strong>{fr ? 'Pas de brouillon disponible' : 'No draft available'}</strong>{' '}
            {fr
              ? '— écrivez ce message vous-même. Le canevas ci-dessous reprend les faits du dossier.'
              : '— write this message yourself. The skeleton below restates the dossier facts.'}
            {draft.reason && (
              <div style={{ marginTop: 4, fontSize: 11, fontFamily: 'ui-monospace,monospace' }}>
                {draft.reason}
                {draft.violations.length > 0 ? ` · ${draft.violations.join(', ')}` : ''}
              </div>
            )}
          </div>
        )}

        {pendingTone && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
            <span>
              {fr ? 'Remplacer votre version par un nouveau brouillon ?' : 'Replace your version with a new draft?'}
            </span>
            <button type="button" className="btn" style={{ padding: '4px 10px' }} onClick={() => setPendingTone(null)}>
              {fr ? 'Non' : 'No'}
            </button>
            <button type="button" className="btn primary" style={{ padding: '4px 10px' }} onClick={() => void switchTone(pendingTone)}>
              {fr ? 'Oui' : 'Yes'}
            </button>
          </div>
        )}

        <label htmlFor="draft-subject" className="sr-only">{fr ? 'Objet' : 'Subject'}</label>
        <input
          id="draft-subject"
          data-testid="draft-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={done || readOnly || mode === 'working'}
          style={{
            width: '100%', border: '1px solid var(--line-2)', borderRadius: 8,
            padding: '8px 10px', fontSize: 13.5, fontWeight: 600, background: '#fff',
          }}
        />

        <label htmlFor="draft-body" className="sr-only">{fr ? 'Message' : 'Message'}</label>
        <textarea
          id="draft-body"
          data-testid="draft-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={done || readOnly || mode === 'working'}
          rows={12}
          spellCheck
          style={{
            width: '100%', minHeight: 232, resize: 'vertical',
            border: '1px solid var(--line-2)', borderRadius: 10, padding: '11px 13px',
            fontSize: 13.5, lineHeight: 1.62, fontFamily: 'inherit', color: 'var(--ink)',
            background: '#fff',
          }}
        />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 18 }}>
          <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }} data-testid="word-count">
            {body.trim().split(/\s+/).filter(Boolean).length} {fr ? 'mots' : 'words'}
            {' · '}
            {(body.match(/\?/g) ?? []).length} {fr ? 'question' : 'question'}
          </span>
          {edited && !done && (
            <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }} data-testid="edited-note">
              {fr ? 'Message modifié — l’écart est enregistré.' : 'Message edited — the difference is recorded.'}
            </span>
          )}
        </div>

        {sandbox && (
          <div data-testid="sandbox-banner" style={{ fontSize: 11.5, color: '#7a4a06', background: '#fffbf3', border: '1px solid #fde3c4', borderRadius: 8, padding: '7px 10px' }}>
            {fr
              ? 'Mode bac à sable : les messages partent à votre adresse, jamais au client. Aucun contact n’est compté.'
              : 'Sandbox mode: messages go to your own address, never the client. No contact is counted.'}
          </div>
        )}

        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: '#b42318' }}>{error}</div>
        )}

        {done || readOnly ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
            <span style={{ color: mode === 'approved' ? '#067647' : 'var(--ink-2)', fontWeight: 600 }}>
              {mode === 'approved'
                ? draft.status === 'sent'
                  ? (fr ? '✓ Envoyé' : '✓ Sent')
                  : (fr ? '✓ Approuvé' : '✓ Approved')
                : mode === 'snoozed'
                ? (fr ? '⏱ Reporté' : '⏱ Snoozed')
                : (fr ? '✓ Écarté' : '✓ Dismissed')}
            </span>
            {nextFollowUp && mode !== 'dismissed' && (
              <span style={{ color: 'var(--ink-2)' }}>
                {fr ? 'prochaine action le ' : 'next action on '}
                {fmtDate(locale, nextFollowUp)}
              </span>
            )}
            <a className="btn" href={`/${locale}`} style={{ marginLeft: 'auto', padding: '6px 12px' }}>
              {fr ? 'Retour à la file' : 'Back to the queue'}
            </a>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              type="button"
              data-testid="approve"
              className="btn primary"
              onClick={() => void approve()}
              disabled={mode === 'working' || !actionId || body.trim() === ''}
              style={{ padding: '9px 16px' }}
            >
              {mode === 'working' ? '…' : (fr ? 'Approuver et envoyer' : 'Approve and send')}
            </button>
            <button
              type="button"
              data-testid="snooze"
              className="btn"
              onClick={() => void snooze()}
              disabled={mode === 'working' || !actionId}
              style={{ padding: '9px 13px' }}
            >
              {fr ? 'Reporter 7 jours' : 'Snooze 7 days'}
            </button>
            <button
              type="button"
              data-testid="dismiss"
              className="btn"
              onClick={() => setDismissOpen((v) => !v)}
              disabled={mode === 'working' || !actionId}
              aria-expanded={dismissOpen}
              style={{ padding: '9px 13px' }}
            >
              {fr ? 'Sans suite' : 'No longer relevant'}
            </button>
          </div>
        )}

        {dismissOpen && !done && (
          <div
            role="group"
            aria-label={fr ? 'Raison de l’abandon' : 'Dismissal reason'}
            style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: '1px solid var(--line-2)', paddingTop: 9 }}
          >
            {DISMISS_REASONS.map((r) => (
              <button
                key={r.id}
                type="button"
                data-testid={`dismiss-${r.id}`}
                className="btn"
                style={{ padding: '5px 10px', fontSize: 11.5 }}
                onClick={() => void dismiss(r.id)}
              >
                {fr ? r.fr : r.en}
              </button>
            ))}
          </div>
        )}

        <p style={{ fontSize: 11, color: 'var(--ink-3)', margin: 0 }}>
          {fr
            ? 'L’approbation n’envoie rien directement : elle autorise l’envoi, que le job exécute après revalidation des sept règles d’arrêt.'
            : 'Approval does not send: it authorises the send, which the job runs after re-checking the seven stop rules.'}
        </p>
      </section>

      {toast && (
        <div
          role="status"
          data-testid="toast"
          style={{
            position: 'fixed', left: 18, bottom: 18, zIndex: 40,
            background: '#101828', color: '#fff', borderRadius: 10,
            padding: '10px 14px', fontSize: 12.5, maxWidth: 380,
            boxShadow: '0 10px 30px rgba(16,24,40,.18)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
