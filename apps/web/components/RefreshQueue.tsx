'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Regenerate today's queue. Kept as JSON + router.refresh() rather than a plain
 * form post: the API answers JSON, and navigating to it would show the payload
 * instead of the screen.
 */
export function RefreshQueue({ locale }: { locale: 'fr' | 'en' }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const res = await fetch('/api/queue/regenerate', { method: 'POST' });
    if (res.status === 429) {
      setError(locale === 'fr' ? 'Trop d’actualisations, réessayez dans une minute.' : 'Too many refreshes, retry in a minute.');
      return;
    }
    if (!res.ok) {
      setError(locale === 'fr' ? 'Actualisation impossible.' : 'Refresh failed.');
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        className="btn"
        type="button"
        onClick={refresh}
        disabled={pending}
        style={{ padding: '6px 11px', fontSize: 12.5 }}
      >
        {pending
          ? (locale === 'fr' ? 'Actualisation…' : 'Refreshing…')
          : (locale === 'fr' ? 'Actualiser' : 'Refresh')}
      </button>
      {error && <span style={{ fontSize: 11, color: '#b42318' }}>{error}</span>}
    </div>
  );
}
