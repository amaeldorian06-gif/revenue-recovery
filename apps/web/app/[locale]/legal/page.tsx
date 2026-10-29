import { redirect } from 'next/navigation';
import { isLocale } from '@rros/i18n';

export const dynamic = 'force-dynamic';

/**
 * /legal — DPA template + sub-processor list. Static, honest, version-dated:
 * a document nobody can find is a document that does not exist.
 */
export default async function LegalPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: rawLocale } = await params;
  if (!isLocale(rawLocale)) redirect('/fr');
  const fr = rawLocale === 'fr';
  return (
    <section style={{ margin: '26px auto', maxWidth: 760, padding: '0 16px', fontSize: 14, lineHeight: 1.55 }} data-testid="legal-page">
      <h1>{fr ? 'Mentions légales, DPA et sous-traitants' : 'Legal, DPA & sub-processors'}</h1>

      <h2>{fr ? 'Sous-traitants (liste tenue à jour)' : 'Sub-processors (kept current)'}</h2>
      <ul>
        <li>{fr ? 'Hébergement & base de données — Supabase (UE), données chiffrées au repos.' : 'Hosting & database — Supabase (EU), encrypted at rest.'}</li>
        <li>{fr ? 'Paiements — virement, Chariow ou Maketou (déclaration + vérification manuelle ; aucun traitement de carte, aucun contenu client transmis).' : 'Payments — bank transfer, Chariow or Maketou (declaration + manual verification; no card processing, no customer content shared).'}</li>
        <li>{fr ? 'E-mail transactionnel — fournisseur à définir avant l’activation (aucun contenu de brouillon transitant en clair).' : 'Transactional email — provider to be chosen before activation (no draft content in clear).'}</li>
      </ul>

      <h2>{fr ? 'Modèle de DPA (résumé opérable)' : 'DPA template (operational summary)'}</h2>
      <ol>
        <li>{fr ? 'Le client est responsable des données ; RROS les traite uniquement pour fournir le service.' : 'The client is the data controller; RROS processes data solely to provide the service.'}</li>
        <li>{fr ? 'Aucun corps d’e-mail n’est stocké par défaut ; les extraits sont plafonnés à 1 000 caractères et purgés à 90 jours.' : 'No email bodies by default; snippets capped at 1 000 characters and purged after 90 days.'}</li>
        <li>{fr ? 'Les journaux d’audit sont conservés 12 mois maximum, puis anonymisés (plus de lien vers une personne).' : 'Audit rows are kept 12 months at most, then anonymised (no longer linked to a person).'}</li>
        <li>{fr ? 'Suppression : révocation immédiate des accès, purge définitive sous 30 jours, table par table.' : 'Deletion: access revoked immediately, hard purge within 30 days, table by table.'}</li>
        <li>{fr ? 'Sous-traitance secondaire interdite sans notification préalable.' : 'No further sub-processing without prior notice.'}</li>
      </ol>
      <p style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>{fr ? 'Version 2026-10-26.' : 'Version 2026-10-26.'}</p>
      <p><a href={`/${rawLocale}/legal/data-processing`}>{fr ? 'Voir : ce que nous stockons et pour combien de temps' : 'See: what we store and for how long'}</a></p>
    </section>
  );
}
