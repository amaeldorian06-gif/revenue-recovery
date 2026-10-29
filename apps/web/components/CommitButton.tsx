'use client';

import { useFormStatus } from 'react-dom';

/**
 * Large files take a few seconds. Silence for four seconds reads as a broken
 * button, so the label switches and the button disables while the server works.
 */
export function CommitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary" type="submit" disabled={pending} aria-busy={pending}>
      {pending ? 'Import en cours… les lignes sont enregistrées par paquets de 500.' : label}
    </button>
  );
}
