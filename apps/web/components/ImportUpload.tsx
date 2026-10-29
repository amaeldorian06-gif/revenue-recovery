'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { uploadAction, type UploadState } from '../lib/actions/import';

const ERRORS: Record<string, string> = {
  no_file: 'Choisissez un fichier.',
  empty_file: 'Le fichier est vide.',
  too_large: 'Fichier trop volumineux (5 Mo maximum).',
  unsupported: 'Format non pris en charge. Utilisez un CSV.',
  parse_failed: 'Le fichier n’a pas pu être lu.',
  no_headers: 'Aucune colonne détectée en première ligne.',
  no_rows: 'Aucune ligne de données.',
  no_client_column: 'Impossible de trouver la colonne du nom du client. Renommez-la « Client » et réessayez.',
  plan_limit: 'Vous avez atteint la limite de votre offre pour ce mois.',
  session: 'Votre session a expiré. Reconnectez-vous.',
};

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary" type="submit" disabled={pending} style={{ marginTop: 16 }}>
      {pending ? 'Lecture du fichier…' : 'Analyser le fichier'}
    </button>
  );
}

export function ImportUpload({ locale, from }: { locale: 'fr' | 'en'; from?: 'onboarding' }) {
  const [state, action] = useActionState<UploadState, FormData>(uploadAction, {});
  const err = state.error ? (ERRORS[state.error] ?? state.error) : null;
  return (
    <form action={action}>
      <input type="hidden" name="locale" value={locale} />
      {from && <input type="hidden" name="from" value={from} />}
      <label htmlFor="file">Fichier de propositions</label>
      <input
        id="file" name="file" type="file" accept=".csv,.tsv,.txt,text/csv"
        required
        style={{ display: 'block', width: '100%', padding: '18px', border: '1px dashed var(--line)', borderRadius: 10, background: '#fcfcfd' }}
      />
      {err && <div className="err" role="alert">{err}</div>}
      <Submit />
    </form>
  );
}
