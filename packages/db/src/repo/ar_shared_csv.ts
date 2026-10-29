import type { ArRow } from './ar_shared.ts';

/** CSV with formula-injection protection (=, +, -, @ prefixed with '). */
export function arToCsv(rows: ArRow[]): string {
  const esc = (v: string): string => {
    const clean = v.replace(/[\r\n]+/g, ' ');
    const guarded = /^[=+\-@]/.test(clean) ? `'${clean}` : clean;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const header = ['client', 'creances_ouvertes', 'encours_eur', 'echu_eur', 'anciennete_max_jours', 'priorite', 'indice_relance', 'score_moteur', 'dernier_contact', 'moteur'];
  const lines = rows.map((r) => [
    esc(r.client),
    String(r.openCount),
    (r.outstandingCents / 100).toFixed(2),
    (r.overdueCents / 100).toFixed(2),
    String(r.oldestAgeDays),
    r.priorityBand,
    String(r.priorityIndex),
    String(r.priorityScoreCents),
    r.lastTouchAt ? r.lastTouchAt.slice(0, 10) : '',
    r.engineVersion,
  ].join(';'));
  return [header.join(';'), ...lines].join('\n');
}
