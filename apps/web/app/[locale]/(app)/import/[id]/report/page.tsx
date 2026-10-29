import { notFound, redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';
import { getSession } from '../../../../../../lib/session';
import { withTenant } from '../../../../../../lib/db';
import { commitImportAction } from '../../../../../../lib/actions/import';
import { importPipeline } from '@rros/domain/import/pipeline';
import type { Mapping } from '@rros/domain/import/detect';
import { loadExisting } from '@rros/db/imports';
import { CommitButton } from '../../../../../../components/CommitButton';

const REASON_LABELS: Record<string, string> = {
  missing_client: 'Nom du client vide',
  missing_amount: 'Montant absent',
  invalid_amount: 'Montant illisible',
  missing_sent_at: "Date d'envoi absente",
  invalid_date: 'Date illisible',
  future_sent_at: 'Date dans le futur',
  too_old: 'Plus de 18 mois',
  duplicate_in_file: 'Doublon dans le fichier',
};

const eur = (c: number) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(c / 100);

export default async function ReportPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { locale, id } = await params;
  const { from } = await searchParams;
  if (!isLocale(locale)) return null;
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);

  const res = await withTenant(session.workspaceId, (db) =>
    db.query<{ staged_rows: Record<string, unknown>[]; mapping: Mapping[]; filename: string; row_count: number }>(
      `select staged_rows, mapping, filename, row_count from imports
       where id = $1::uuid and workspace_id = $2::uuid`,
      [id, session.workspaceId],
    ),
  );
  const imp = res.rows[0];
  if (!imp) notFound();

  const existing = await withTenant(session.workspaceId, (db) => loadExisting(db, session.workspaceId));
  const preview = importPipeline((imp.staged_rows ?? []) as Record<string, unknown>[], {
    mapping: (imp.mapping ?? []) as Mapping[],
    existing,
    now: new Date(),
    holdoutRate: 0.2,
    assignArm: () => 'treatment',
  });

  const byReason = preview.skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.reason] = (acc[s.reason] ?? 0) + 1;
    return acc;
  }, {});

  const exposed = preview.toCreate.reduce((a, o) => a + o.amountCents, 0);

  return (
    <section style={{ marginTop: 22, maxWidth: 760 }}>
      <h2>Vérification</h2>
      <p className="sub">Étape 3 sur 4 · {imp.filename}</p>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 16 }}>
        {[
          { label: 'Lignes lues', value: preview.stats.rows.toLocaleString('fr-FR') },
          { label: 'À créer', value: preview.stats.created.toLocaleString('fr-FR') },
          { label: 'À mettre à jour', value: preview.stats.updated.toLocaleString('fr-FR') },
          { label: 'Refusées', value: preview.stats.skipped.toLocaleString('fr-FR') },
        ].map((k) => (
          <div className="card" key={k.label}>
            <div className="pad">
              <div style={{ fontSize: 11.5, textTransform: 'uppercase', letterSpacing: '.4px', color: 'var(--ink-2)', fontWeight: 600 }}>{k.label}</div>
              <div style={{ fontSize: 24, fontWeight: 680, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="pad">
          <strong style={{ fontSize: 13.5 }}>Montant exposé par les nouvelles propositions</strong>
          <div style={{ fontSize: 22, fontWeight: 680, marginTop: 4, color: 'var(--accent-ink)' }}>{eur(exposed)}</div>
        </div>
      </div>

      {Object.keys(byReason).length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="pad">
            <strong style={{ fontSize: 13.5 }}>Pourquoi certaines lignes sont refusées</strong>
            <table style={{ marginTop: 10 }}>
              <tbody>
                {Object.entries(byReason).map(([reason, n]) => (
                  <tr key={reason}>
                    <td>{REASON_LABELS[reason] ?? reason}</td>
                    <td className="num" style={{ textAlign: 'right', fontWeight: 600 }}>{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sub" style={{ marginTop: 8, fontSize: 12 }}>
              Ces lignes ne sont pas corrigées automatiquement : une valeur devinée fausserait
              toutes les mesures qui suivent.
            </p>
            <a
              href={`/api/imports/${id}/rejected`}
              className="btn"
              style={{ marginTop: 10, fontSize: 12.5, padding: '6px 11px' }}
            >
              Télécharger les lignes refusées (CSV)
            </a>
          </div>
        </div>
      )}

      <form action={commitImportAction} style={{ marginTop: 18 }}>
        <input type="hidden" name="importId" value={id} />
        {from === 'onboarding' && <input type="hidden" name="from" value="onboarding" />}
        <CommitButton
          label={`Importer ${preview.stats.created + preview.stats.updated} ligne${
            preview.stats.created + preview.stats.updated > 1 ? 's' : ''
          }`}
        />
      </form>
    </section>
  );
}
