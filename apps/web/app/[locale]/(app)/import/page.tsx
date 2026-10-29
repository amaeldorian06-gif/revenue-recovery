import { translator, isLocale } from '@rros/i18n';
import { ImportUpload } from '../../../../components/ImportUpload';

export default async function ImportPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) return null;
  const tr = translator(locale);
  return (
    <section style={{ marginTop: 22, maxWidth: 720 }}>
      <h2>{tr('today.cta.import')}</h2>
      <p className="sub">Étape 1 sur 4 · CSV ou TSV, 5 Mo maximum, 5 000 lignes.</p>
      <div className="card" style={{ marginTop: 16 }}>
        <div className="pad">
          <ImportUpload locale={locale} />
        </div>
      </div>
      <div className="note" style={{ marginTop: 16 }}>
        <strong>Ce que nous cherchons dans votre fichier :</strong> le nom du client, le montant,
        la date d&apos;envoi, le stade et le nombre de relances. Nous détectons les colonnes
        automatiquement et vous montrons le résultat avant d&apos;importer quoi que ce soit.
      </div>
    </section>
  );
}
