'use client';

import { useState } from 'react';
import { dismissCoachMarkAction } from '../lib/actions/onboarding';

/**
 * The single coach-mark. Shown once, ever — the flag lives server-side in
 * onboarding_state, so "once" survives browsers, devices and reinstalls.
 */
export function CoachMark({ locale }: { locale: 'fr' | 'en' }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const fr = locale === 'fr';
  return (
    <div
      data-testid="coach-mark"
      role="note"
      style={{
        border: '1px solid var(--accent)', background: '#f2f7ff', borderRadius: 12,
        padding: '14px 16px', marginBottom: 14, display: 'flex', gap: 12, alignItems: 'flex-start',
      }}
    >
      <div style={{ fontSize: 18 }}>👆</div>
      <div style={{ flex: 1 }}>
        <strong style={{ fontSize: 13.5 }}>{fr ? 'Voici pourquoi ce dossier est en premier' : 'Why this dossier is first'}</strong>
        <p className="sub" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
          {fr
            ? 'Chaque dossier porte son explication : montant exposé, silence, ancienneté. Vous restez juge — le produit ne fait que classer.'
            : 'Every dossier carries its explanation: exposed amount, silence, age. You stay the judge — the product only ranks.'}
        </p>
      </div>
      <form action={async () => {
        await dismissCoachMarkAction();
        setOpen(false);
      }}>
        <button className="btn" type="submit" data-testid="coach-dismiss" style={{ padding: '5px 10px', fontSize: 12 }}>
          {fr ? 'Compris' : 'Got it'}
        </button>
      </form>
    </div>
  );
}
