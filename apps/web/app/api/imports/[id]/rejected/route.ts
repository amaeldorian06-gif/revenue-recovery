import { NextResponse } from 'next/server';
import { getSession } from '../../../../../lib/session';
import { withTenant } from '../../../../../lib/db';
import { loadExisting } from '@rros/db/imports';
import { importPipeline } from '@rros/domain/import/pipeline';
import type { Mapping } from '@rros/domain/import/detect';

export const dynamic = 'force-dynamic';

const REASON_FR: Record<string, string> = {
  missing_client: 'Nom du client vide',
  missing_amount: 'Montant absent',
  invalid_amount: 'Montant illisible',
  missing_sent_at: "Date d'envoi absente",
  invalid_date: 'Date illisible',
  future_sent_at: 'Date dans le futur',
  too_old: 'Plus de 18 mois',
  duplicate_in_file: 'Doublon dans le fichier',
};

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The rejected rows, verbatim, with the reason appended. Deliberately NOT
 * corrected: a guessed amount would poison every figure downstream, so the file
 * is meant to be fixed by the person who knows the deal.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { id } = await params;

  const res = await withTenant(session.workspaceId, (db) =>
    db.query<{ staged_rows: Record<string, unknown>[]; mapping: Mapping[]; headers: string[]; filename: string }>(
      `select staged_rows, mapping, headers, filename from imports
        where id = $1::uuid and workspace_id = $2::uuid`,
      [id, session.workspaceId],
    ),
  );
  const imp = res.rows[0];
  if (!imp) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const existing = await withTenant(session.workspaceId, (db) => loadExisting(db, session.workspaceId));
  const preview = importPipeline((imp.staged_rows ?? []) as Record<string, unknown>[], {
    mapping: (imp.mapping ?? []) as Mapping[],
    existing, now: new Date(), holdoutRate: 0.2, assignArm: () => 'treatment',
  });

  const headers = (imp.headers ?? []) as string[];
  const staged = (imp.staged_rows ?? []) as Record<string, unknown>[];
  const lines = [
    [...headers, 'Motif du refus'].map(cell).join(';'),
    ...preview.skipped.map((s) => {
      const row = staged[s.rowIndex] ?? {};
      return [...headers.map((h) => cell(row[h])), cell(REASON_FR[s.reason] ?? s.reason)].join(';');
    }),
  ];

  const name = imp.filename.replace(/\.[^.]+$/, '');
  return new NextResponse('\ufeff' + lines.join('\r\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="refusees-${name}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
