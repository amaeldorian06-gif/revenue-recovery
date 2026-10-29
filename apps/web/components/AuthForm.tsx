'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { signupAction, signinAction, type ActionState } from '../lib/actions/auth';

const ERRORS: Record<string, Record<string, string>> = {
  fr: {
    email_invalid: 'Entrez une adresse e-mail valide.',
    workspace_invalid: "Le nom de l'agence doit contenir au moins 2 caractères.",
    exists: 'Un espace existe déjà pour cette adresse.',
    unknown: 'Aucun compte pour cette adresse.',
  },
  en: {
    email_invalid: 'Enter a valid email address.',
    workspace_invalid: 'The agency name must be at least 2 characters.',
    exists: 'A workspace already exists for this address.',
    unknown: 'No account for this address.',
  },
};

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn primary" type="submit" disabled={pending} style={{ width: '100%', marginTop: 18 }}>
      {pending ? '…' : label}
    </button>
  );
}

export function AuthForm({ mode, locale }: { mode: 'signin' | 'signup'; locale: 'fr' | 'en' }) {
  const action = mode === 'signin' ? signinAction : signupAction;
  const [state, formAction] = useActionState<ActionState, FormData>(action, {});
  const L = locale === 'fr'
    ? { email: 'Adresse e-mail', workspace: "Nom de l'agence", submit: 'Créer mon espace', submitIn: 'Recevoir le lien' }
    : { email: 'Email address', workspace: 'Agency name', submit: 'Create my workspace', submitIn: 'Send the link' };
  const err = state.error ? (ERRORS[locale]?.[state.error] ?? state.error) : null;

  return (
    <form action={formAction}>
      <input type="hidden" name="locale" value={locale} />
      <label htmlFor="email">{L.email}</label>
      <input id="email" name="email" type="email" required autoComplete="email" placeholder="vous@agence.fr" />
      {mode === 'signup' && (
        <>
          <label htmlFor="workspace">{L.workspace}</label>
          <input id="workspace" name="workspace" type="text" required minLength={2} placeholder="Studio Merlot" />
        </>
      )}
      {err && <div className="err" role="alert">{err}</div>}
      <Submit label={mode === 'signin' ? L.submitIn : L.submit} />
    </form>
  );
}
