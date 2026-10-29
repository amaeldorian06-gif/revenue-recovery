'use client';

import { useActionState } from 'react';
import { createOpportunityAction, type OpportunityState } from '../lib/actions/opportunities';

const STAGES = [
  ['proposal_sent', 'Proposition envoyée'],
  ['followup_1', 'Relance 1'],
  ['followup_2', 'Relance 2'],
  ['followup_3', 'Relance 3'],
  ['verbal_yes', 'Accord oral'],
  ['negotiation', 'Négociation'],
  ['other', 'Autre'],
] as const;

const ERRORS: Record<string, string> = {
  client: 'Le nom du client est obligatoire.',
  amount: 'Montant illisible. Exemples acceptés : 4 500,00 € · 4500.00 · 1,5k',
  date: "Date illisible ou dans le futur. Format attendu : jj/mm/aaaa.",
  forbidden: "Votre rôle ne permet pas de modifier le portefeuille.",
  missing: 'Champs manquants.',
};

export function OpportunityForm({ initial }: { initial?: {
  id: string; client_name: string; title: string; amount: string; sent_at: string;
  stage: string; contact_email: string;
} }) {
  const [state, action, pending] = useActionState<OpportunityState, FormData>(
    createOpportunityAction,
    {},
  );

  return (
    <form action={action}>
      <div className="row2">
        <div>
          <label className="f" htmlFor="client_name">Client *</label>
          <input className="f" id="client_name" name="client_name" required defaultValue={initial?.client_name} />
        </div>
        <div>
          <label className="f" htmlFor="amount">Montant *</label>
          <input className="f" id="amount" name="amount" required placeholder="4 500,00 €" defaultValue={initial?.amount} />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label className="f" htmlFor="title">Objet de la proposition</label>
        <input className="f" id="title" name="title" defaultValue={initial?.title} />
      </div>
      <div className="row2" style={{ marginTop: 12 }}>
        <div>
          <label className="f" htmlFor="sent_at">Date d&apos;envoi *</label>
          <input className="f" id="sent_at" name="sent_at" required placeholder="03/04/2026" defaultValue={initial?.sent_at} />
        </div>
        <div>
          <label className="f" htmlFor="stage">Stade</label>
          <select className="f" id="stage" name="stage" defaultValue={initial?.stage ?? 'proposal_sent'}>
            {STAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label className="f" htmlFor="contact_email">E-mail du contact</label>
        <input className="f" id="contact_email" name="contact_email" type="email" defaultValue={initial?.contact_email} />
      </div>

      {state.error && <div className="err" role="alert">{ERRORS[state.error] ?? 'Erreur.'}</div>}

      <button className="btn primary" type="submit" disabled={pending} style={{ marginTop: 14 }}>
        {pending ? 'Enregistrement…' : 'Enregistrer la proposition'}
      </button>
      <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>
        Le groupe (traité ou témoin) est tiré au hasard et ne peut pas être choisi — c&apos;est ce qui
        rend la mesure du gain possible.
      </p>
    </form>
  );
}
