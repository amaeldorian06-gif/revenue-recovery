import { STAGES, type Stage } from './normalize.ts';

/**
 * Column detection. The mapping UI is where a customer decides whether the tool
 * understands their business, so a wrong guess is worse than an honest question.
 * Confidence is returned with every guess; below 0.6 the UI asks.
 */

export const TARGET_FIELDS = [
  'client_name',
  'title',
  'amount_cents',
  'sent_at',
  'stage',
  'last_touch_at',
  'touch_count',
  'contact_email',
  'external_ref',
] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

export const REQUIRED_FIELDS: TargetField[] = ['client_name', 'amount_cents', 'sent_at'];

const SYNONYMS: Record<TargetField, string[]> = {
  client_name: ['client', 'societe', 'société', 'company', 'account', 'entreprise', 'customer', 'nom du client', 'raison sociale', 'organisation', 'organization'],
  title: ['objet', 'intitule', 'intitulé', 'title', 'sujet', 'description', 'projet', 'project', 'libelle', 'libellé', 'prestation', 'mission'],
  amount_cents: ['montant', 'total', 'amount', 'value', 'prix', 'price', 'tarif', 'budget', 'somme', 'montant ht', 'montant ttc', 'montant eur', 'ca'],
  sent_at: ['date', 'envoye', 'envoyé', 'date envoi', 'date d envoi', 'sent', 'sent at', 'created', 'created at', 'proposition', 'date proposition', 'date devis', 'date envoi devis'],
  stage: ['stade', 'etape', 'étape', 'statut', 'stage', 'status', 'phase', 'avancement'],
  last_touch_at: ['dernier contact', 'last contact', 'relance', 'date relance', 'derniere relance', 'dernière relance', 'updated', 'updated at', 'derniere interaction'],
  touch_count: ['relances', 'nb relances', 'nombre de relances', 'touches', 'follow ups', 'followups', 'follow-ups', 'nb contacts'],
  contact_email: ['email', 'courriel', 'mail', 'contact', 'destinataire', 'email contact', 'e mail', 'adresse email'],
  external_ref: ['id', 'reference', 'référence', 'ref', 'numero', 'numéro', 'num', 'devis', 'quote', 'opportunity id', 'opportunite', 'opportunité'],
};

/** Header-level hints, stronger than a bare synonym match. */
const HEADER_HINTS: Partial<Record<TargetField, RegExp>> = {
  amount_cents: /(montant|amount|prix|price|total|budget|€|eur)/i,
  sent_at: /(date|envoy|sent|created)/i,
  contact_email: /(e.?mail|courriel|mail)/i,
  touch_count: /(nb|nombre|count)/i,
};

export interface ColumnGuess {
  field: TargetField;
  column: string;
  confidence: number;
}

export interface Mapping {
  field: TargetField;
  column: string | null;
  confidence: number;
}

function deburr(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreHeader(header: string, field: TargetField): number {
  const h = deburr(header);
  if (h === '') return 0;

  let best = 0;
  for (const syn of SYNONYMS[field]) {
    const s = deburr(syn);
    if (h === s) best = Math.max(best, 0.95);
    else if (h.includes(s) && s.length >= 4) best = Math.max(best, 0.8);
    else if (s.includes(h) && h.length >= 4) best = Math.max(best, 0.6);
  }
  if (best > 0 && HEADER_HINTS[field]?.test(header)) best = Math.min(0.98, best + 0.05);
  return best;
}

/**
 * Assign each target field at most one column, greedy by descending score, so a
 * single "Email client" column is never consumed twice. Ambiguity is unresolved
 * on purpose: two candidates within 0.1 produce confidence < 0.6 and the UI asks.
 */
export function detectMapping(headers: string[]): Mapping[] {
  const cleaned = headers.map((h) => h ?? '');
  const pairs: ColumnGuess[] = [];
  for (const field of TARGET_FIELDS) {
    for (const column of cleaned) {
      const confidence = scoreHeader(column, field);
      if (confidence > 0) pairs.push({ field, column, confidence });
    }
  }
  pairs.sort((a, b) => b.confidence - a.confidence || a.field.localeCompare(b.field));

  const takenFields = new Set<TargetField>();
  const takenColumns = new Set<string>();
  const chosen = new Map<TargetField, ColumnGuess>();

  for (const p of pairs) {
    if (takenFields.has(p.field) || takenColumns.has(p.column)) continue;
    takenFields.add(p.field);
    takenColumns.add(p.column);
    chosen.set(p.field, p);
  }

  return TARGET_FIELDS.map((field) => {
    const hit = chosen.get(field);
    if (!hit) return { field, column: null, confidence: 0 };
    // Penalise an ambiguous winner: another column scores almost as well.
    const rival = pairs.find(
      (p) => p.field === field && p.column !== hit.column && hit.confidence - p.confidence < 0.1,
    );
    const confidence = rival ? Math.min(hit.confidence, 0.55) : hit.confidence;
    return { field, column: hit.column, confidence: Number(confidence.toFixed(2)) };
  });
}

export function isMappingUsable(mapping: Mapping[]): { ok: boolean; missing: TargetField[] } {
  const byField = new Map(mapping.map((m) => [m.field, m]));
  const missing = REQUIRED_FIELDS.filter((f) => !byField.get(f)?.column);
  return { ok: missing.length === 0, missing };
}

export function stageValues(): readonly Stage[] {
  return STAGES;
}
