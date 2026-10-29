'use client';

import { useActionState } from 'react';
import { deleteWorkspaceAction } from '../lib/actions/team';

/**
 * The typed-name confirmation for workspace deletion — "confirmation by
 * typing the workspace name". Client-side friction, server-side truth.
 */
export function DeleteWorkspaceForm({ locale, name }: { locale: 'fr' | 'en'; name: string }) {
  const [state, action] = useActionState(deleteWorkspaceAction, null);
  const fr = locale === 'fr';
  return (
    <form action={action} style={{ display: 'grid', gap: 8, marginTop: 10, maxWidth: 380 }} data-testid="delete-workspace-form">
      <input
        name="confirm"
        required
        placeholder={fr ? `Tapez « ${name} »` : `Type “${name}”`}
        style={{ padding: '8px 12px', border: '1px solid #b42318', borderRadius: 8, fontSize: 13.5 }}
        data-testid="delete-workspace-confirm"
      />
      <button className="btn" type="submit" style={{ background: '#b42318', color: '#fff', borderColor: '#b42318' }} data-testid="delete-workspace-submit">
        {fr ? 'Supprimer définitivement (30 jours)' : 'Delete permanently (30 days)'}
      </button>
      {state?.error === 'name_mismatch' && (
        <p style={{ color: '#b42318', fontSize: 12.5 }}>{fr ? 'Le nom ne correspond pas.' : 'The name does not match.'}</p>
      )}
      {state?.error === 'ROLE_FORBIDDEN' && (
        <p style={{ color: '#b42318', fontSize: 12.5 }}>{fr ? 'Seul le propriétaire peut supprimer.' : 'Only the owner can delete.'}</p>
      )}
    </form>
  );
}
