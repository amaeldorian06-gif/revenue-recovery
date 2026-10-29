'use client';

import { useEffect, useState } from 'react';
import { useActionState } from 'react';
import { closeOpportunityAction, undoCloseOpportunityAction } from '../lib/actions/dossier';

/**
 * One-click Won/Lost, with the 10-second undo the prompt demands. The server
 * keeps the door open for exactly 10 seconds (SQL guard on closed_at); the
 * toast is only its visible half.
 */
export function CloseWithUndo({
  locale, opportunityId,
}: {
  locale: 'fr' | 'en';
  opportunityId: string;
}) {
  const [closed, closeAction] = useActionState(closeOpportunityAction, null);
  const [undone, undoAction] = useActionState(undoCloseOpportunityAction, null);
  const [seconds, setSeconds] = useState(10);
  const fr = locale === 'fr';

  useEffect(() => {
    if (undone?.ok) return;
    if (closed === null) return;
    setSeconds(10);
    const tick = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    const done = setTimeout(() => {
      // The window is over: navigate away — the dossier left the queue.
      window.location.href = `/${locale}`;
    }, 10_000);
    return () => { clearInterval(tick); clearTimeout(done); };
  }, [closed, undone, locale]);

  if (closed !== null && !undone?.ok) {
    return (
      <div
        data-testid="undo-toast"
        role="status"
        style={{
          display: 'flex', gap: 12, alignItems: 'center', marginTop: 14,
          border: '1px solid var(--accent)', background: '#f2f7ff', borderRadius: 10, padding: '10px 14px',
        }}
      >
        <span style={{ fontSize: 13 }}>
          {fr ? `Dossier marqué « ${closed.status === 'won' ? 'gagné' : 'perdu'} » · sortie de la file dans ${seconds} s` : `Marked ${closed.status} · leaves the queue in ${seconds} s`}
        </span>
        <form action={undoAction}>
          <input type="hidden" name="opportunityId" value={opportunityId} />
          <button className="btn" type="submit" data-testid="undo-close">
            {fr ? 'Annuler' : 'Undo'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 10, marginTop: 14 }} data-testid="close-actions">
      <form action={closeAction}>
        <input type="hidden" name="opportunityId" value={opportunityId} />
        <input type="hidden" name="status" value="won" />
        <button className="btn primary" type="submit" data-testid="mark-won">
          {fr ? 'Gagné' : 'Won'}
        </button>
      </form>
      <form action={closeAction}>
        <input type="hidden" name="opportunityId" value={opportunityId} />
        <input type="hidden" name="status" value="lost" />
        <button className="btn" type="submit" data-testid="mark-lost">
          {fr ? 'Perdu' : 'Lost'}
        </button>
      </form>
    </div>
  );
}
