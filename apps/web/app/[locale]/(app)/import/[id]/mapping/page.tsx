import { notFound, redirect } from 'next/navigation';
import { translator, isLocale } from '@rros/i18n';
import { getSession } from '../../../../../../lib/session';
import { withTenant } from '../../../../../../lib/db';
import { saveMappingAction } from '../../../../../../lib/actions/import';
import type { Mapping, TargetField } from '@rros/domain/import/detect';

const LABELS: Partial<Record<TargetField, { fr: string; en: string; required?: boolean }>> = {
  client_name: { fr: 'Nom du client', en: 'Client name', required: true },
  amount_cents: { fr: 'Montant', en: 'Amount', required: true },
  sent_at: { fr: "Date d'envoi", en: 'Sent date', required: true },
  title: { fr: 'Objet de la proposition', en: 'Proposal title' },
  stage: { fr: 'Stade commercial', en: 'Stage' },
  last_touch_at: { fr: 'Dernier contact', en: 'Last contact' },
  touch_count: { fr: 'Nombre de relances', en: 'Follow-up count' },
  contact_email: { fr: 'E-mail du contact', en: 'Contact email' },
  external_ref: { fr: 'Référence / n° de devis', en: 'Reference / quote no.' },
};

export default async function MappingPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ error?: string; from?: string }>;
}) {
  const { locale, id } = await params;
  const { error, from } = await searchParams;
  if (!isLocale(locale)) return null;
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  const tr = translator(locale);

  const res = await withTenant(session.workspaceId, (db) =>
    db.query<{ filename: string; row_count: number; headers: string[]; mapping: Mapping[]; encoding: string }>(
      `select filename, row_count, headers, mapping, encoding
       from imports where id = $1::uuid and workspace_id = $2::uuid`,
      [id, session.workspaceId],
    ),
  );
  const imp = res.rows[0];
  if (!imp) notFound();

  const headers = (imp.headers ?? []) as string[];
  const mapping = (imp.mapping ?? []) as Mapping[];

  return (
    <section style={{ marginTop: 22, maxWidth: 760 }}>
      <h2>Associer les colonnes</h2>
      <p className="sub">
        Étape 2 sur 4 · {imp.filename} — {imp.row_count} lignes · encodage {imp.encoding}
      </p>

      {error === 'missing' && (
        <div className="err" role="alert">
          Trois champs sont obligatoires : le nom du client, le montant et la date d&apos;envoi.
        </div>
      )}

      <form action={saveMappingAction}>
        <input type="hidden" name="importId" value={id} />
        {from === 'onboarding' && <input type="hidden" name="from" value="onboarding" />}
        <div className="card" style={{ marginTop: 14 }}>
          <div className="pad">
            {(Object.keys(LABELS) as TargetField[]).map((field) => {
              const current = mapping.find((m) => m.field === field);
              const label = LABELS[field];
              if (!label) return null;
              return (
                <div
                  key={field}
                  style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--line-2)' }}
                >
                  <div>
                    <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {locale === 'fr' ? label.fr : label.en}
                      {label.required && <span style={{ color: '#b42318' }}> *</span>}
                    </div>
                    {current && current.confidence > 0 && current.confidence < 0.6 && (
                      <div style={{ fontSize: 11.5, color: 'var(--warn)' }}>
                        Détection peu sûre — vérifiez
                      </div>
                    )}
                  </div>
                  <select
                    name={`map_${field}`}
                    defaultValue={current?.column ?? ''}
                    style={{ font: 'inherit', fontSize: 13.5, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line)', background: '#fff' }}
                  >
                    <option value="">— non utilisé —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
        <button className="btn primary" type="submit" style={{ marginTop: 16 }}>
          Vérifier les données
        </button>
      </form>

      <div className="note" style={{ marginTop: 16 }}>
        <strong>Rien n&apos;est encore enregistré.</strong> L&apos;étape suivante vous montre exactement
        ce qui sera importé, ce qui sera fusionné et ce qui sera refusé — avec la raison.
      </div>
    </section>
  );
}
