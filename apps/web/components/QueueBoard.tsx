'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { whyNow, topSentences, formulaLines, type Locale } from '@rros/domain/scoring/explanations';
import type { QueueItemView } from '@rros/db/queue';
import type { Factor } from '@rros/domain/scoring';

const EUR = (locale: Locale) => (cents: number) =>
  new Intl.NumberFormat(locale === 'fr' ? 'fr-FR' : 'en-GB', {
    style: 'currency', currency: 'EUR', maximumFractionDigits: 0,
  }).format(cents / 100);

const PCT = (n: number) => `${Math.round(n * 100)} %`;

const STAGE_FR: Record<string, string> = {
  proposal_sent: 'Proposition envoyée',
  followup_1: 'Relance 1',
  followup_2: 'Relance 2',
  followup_3: 'Relance 3',
  verbal_yes: 'Accord oral',
  negotiation: 'Négociation',
  other: 'Autre',
};

interface Props {
  items: QueueItemView[];
  locale: Locale;
  today: string;
  totalOpportunities: number;
  onRegenerate?: () => void;
}

export function QueueBoard({ items, locale, today, totalOpportunities }: Props) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const cardRefs = useRef<Array<HTMLLIElement | null>>([]);

  const eur = useMemo(() => EUR(locale), [locale]);

  // j/k/Enter/Escape — the keyboard is not a flourish: this screen is used 8 times
  // a day by people who live on the keyboard.
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
      if (typing) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(items.length - 1, c + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter') {
        const item = items[cursor];
        if (item) {
          e.preventDefault();
          setOpenId((id) => (id === item.opportunityId ? null : item.opportunityId));
        }
      } else if (e.key === 'Escape') {
        setOpenId(null);
      }
    },
    [cursor, items],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  useEffect(() => {
    cardRefs.current[cursor]?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useEffect(() => {
    const item = items.find((i) => i.opportunityId === openId);
    if (item) {
      setAnnouncement(
        locale === 'fr'
          ? `Détail ouvert : ${item.clientName}, priorité ${item.priorityIndex} sur 100.`
          : `Details opened: ${item.clientName}, priority ${item.priorityIndex} out of 100.`,
      );
    }
  }, [openId, items, locale]);

  if (items.length === 0) return null;

  return (
    <>
      <p aria-live="polite" className="sr-only" data-testid="queue-live">
        {announcement}
      </p>

      <ol
        style={{ listStyle: 'none', padding: 0, margin: '16px 0 0', display: 'grid', gap: 10 }}
        aria-label={locale === 'fr' ? `File du jour du ${today}` : `Today's queue, ${today}`}
      >
        {items.map((item, index) => {
          const isOpen = openId === item.opportunityId;
          const isCursor = cursor === index;
          const days = Math.max(
            0,
            Math.floor((Date.now() - new Date(item.sentAt).getTime()) / 86_400_000),
          );
          const sentence = whyNow(item.factors, locale);
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

          return (
            <li
              key={item.opportunityId}
              ref={(el) => { cardRefs.current[index] = el; }}
              className="card"
              style={{
                outline: isCursor ? '2px solid var(--accent)' : 'none',
                outlineOffset: 2,
                borderColor: isCursor ? '#99e0d3' : undefined,
              }}
              onMouseEnter={() => setCursor(index)}
            >
              <div style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <div
                    aria-label={locale === 'fr' ? `Priorité ${item.priorityIndex} sur 100` : `Priority ${item.priorityIndex} out of 100`}
                    style={{
                      minWidth: 52, height: 44, borderRadius: 10, display: 'grid', placeItems: 'center',
                      background: item.priorityIndex >= 70 ? '#fef3f2' : item.priorityIndex >= 40 ? '#fffaeb' : '#f2f4f7',
                      color: item.priorityIndex >= 70 ? '#b42318' : item.priorityIndex >= 40 ? '#b54708' : '#475467',
                      fontWeight: 700, fontSize: 17, fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {item.priorityIndex}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 14.5 }}>{item.clientName}</strong>
                      <span style={{ fontSize: 14, color: 'var(--ink-2)', fontVariantNumeric: 'tabular-nums' }}>
                        {eur(item.amountCents)}
                      </span>
                    </div>
                    <div style={{
                      fontSize: 12.5, color: 'var(--ink-3)', marginTop: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {item.title ?? '—'}
                    </div>

                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {item.opens14d > 0 && (
                        <span className="badge watch">
                          {locale === 'fr' ? `ouvert ${item.opens14d}×` : `opened ${item.opens14d}×`}
                        </span>
                      )}
                      <span className={item.touchCount === 0 ? 'badge no_reply' : 'badge watch'}>
                        {item.touchCount === 0
                          ? (locale === 'fr' ? 'jamais relancée' : 'never followed up')
                          : (locale === 'fr' ? `${item.touchCount} relance${item.touchCount > 1 ? 's' : ''}` : `${item.touchCount} follow-up${item.touchCount > 1 ? 's' : ''}`)}
                      </span>
                      <span className={days >= 18 ? 'badge late_action' : 'badge watch'}>
                        {locale === 'fr' ? `${days} j sans réponse` : `${days} d unanswered`}
                      </span>
                      <span className="badge watch">{STAGE_FR[item.stage] ?? item.stage}</span>
                    </div>

                    <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--ink-2)' }}>{sentence}</p>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                    <button
                      type="button"
                      className="btn primary"
                      style={{ padding: '7px 13px', whiteSpace: 'nowrap' }}
                      aria-expanded={isOpen}
                      onClick={() => setOpenId(isOpen ? null : item.opportunityId)}
                    >
                      {isOpen ? (locale === 'fr' ? 'Fermer' : 'Close') : (locale === 'fr' ? 'Ouvrir' : 'Open')}
                    </button>
                    <a
                      href={`/${locale}/pipeline/${item.opportunityId}`}
                      style={{ fontSize: 11.5, color: 'var(--ink-3)' }}
                    >
                      {locale === 'fr' ? 'fiche' : 'details'}
                    </a>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 14, borderTop: '1px solid var(--line-2)', paddingTop: 14 }}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                      {[
                        { label: locale === 'fr' ? 'valeur attendue' : 'expected value', v: eur(item.expectedValueCents), raw: Math.min(1, item.expectedValueCents / Math.max(1, item.amountCents)) },
                        { label: 'p(réponse)', v: PCT(item.pReply), raw: item.pReply },
                        { label: 'p(conversion)', v: PCT(item.pConvert), raw: item.pConvert },
                        { label: locale === 'fr' ? 'urgence' : 'urgency', v: item.urgency.toFixed(2), raw: item.urgency },
                      ].map((m) => (
                        <div key={m.label}>
                          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.3px', color: 'var(--ink-3)', fontWeight: 600 }}>
                            {m.label}
                          </div>
                          <div style={{ fontSize: 15, fontWeight: 650, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>
                            {m.v}
                          </div>
                          <div style={{ height: 4, background: '#eef0f3', borderRadius: 99, marginTop: 5 }}>
                            <div style={{ height: 4, width: `${Math.round(m.raw * 100)}%`, background: 'var(--accent)', borderRadius: 99 }} />
                          </div>
                        </div>
                      ))}
                    </div>

                    <pre style={{
                      marginTop: 12, marginBottom: 0, background: '#0f172a', color: '#e2e8f0',
                      padding: '10px 12px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.7,
                      fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', overflowX: 'auto',
                    }}>
{expectedLine}
{'\n'}{priorityLine}
                    </pre>

                    <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-2)' }}>
                      {topSentences(item.factors, locale).map((s) => (
                        <li key={s}>{s}</li>
                      ))}
                    </ul>

                    <p style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 8 }}>
                      {locale === 'fr'
                        ? `moteur ${item.engineVersion} · priorité relative aux autres dossiers du jour, pas une probabilité`
                        : `engine ${item.engineVersion} · priority relative to today's other dossiers, not a probability`}
                    </p>

                    <a
                      className="btn primary"
                      href={`/${locale}/queue/${item.opportunityId}`}
                      style={{ marginTop: 10, display: 'inline-block' }}
                      data-testid="open-card"
                    >
                      {locale === 'fr' ? 'Écrire la relance' : 'Write the follow-up'} →
                    </a>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <p style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 10 }}>
        {locale === 'fr'
          ? `j / k pour naviguer · Entrée pour ouvrir · Échap pour fermer · ${totalOpportunities} dossiers dans le portefeuille`
          : `j / k to move · Enter to open · Esc to close · ${totalOpportunities} dossiers in the portfolio`}
      </p>
    </>
  );
}
