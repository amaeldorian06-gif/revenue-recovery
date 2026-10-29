import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { getSession } from '../../../../lib/session';
import { parseCsvBuffer } from '@rros/domain/import/parse';
import { detectMapping, isMappingUsable } from '@rros/domain/import/detect';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * DEV ONLY (RROS_DEV_SEED=1) — the phase-08 load dataset: 5 000 opportunities
 * + 60 000 signal events in the RUNNING dev database, plus a CSV import that
 * runs the exact production pipeline (parseCsvBuffer → detectMapping →
 * staged insert). PERF.md records the numbers measured through this route.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    opportunities?: number; signals?: number; importRows?: number;
  };
  const nOpps = Math.min(body.opportunities ?? 5_000, 20_000);
  const nSignals = Math.min(body.signals ?? 60_000, 200_000);

  return asAdmin(async (conn) => {
    const t0 = Date.now();
    // Idempotent re-runs: a previous partial seed must not collide.
    await conn.query(
      `delete from signal_events se using opportunities o
        where se.opportunity_id = o.id and o.workspace_id = $1::uuid and o.external_ref like 'ref-load-%'`,
      [session.workspaceId],
    );
    await conn.query(
      `delete from opportunities where workspace_id = $1::uuid and external_ref like 'ref-load-%'`,
      [session.workspaceId],
    );
    await conn.query(
      `delete from contacts where workspace_id = $1::uuid and email like 'contact%@client-%.example.com'`,
      [session.workspaceId],
    );
    // Plan ceiling lifted for the load workspace so entitlements never gate the bench.
    await conn.query(`update workspaces set plan = 'scale' where id = $1::uuid`, [session.workspaceId]);

    const clients = Array.from({ length: 400 }, (_, i) => `Client ${String(i).padStart(3, '0')}`);
    const stages = ['proposal_sent', 'followup_1', 'followup_2', 'negotiation'];
    // Eligibility calibrated for a realistic day: 80 % candidates, 10 % TOO_SOON
    // (sent recently), 10 % TOUCH_LIMIT (3 touches). Without contacts there is
    // nothing to draft — the queue would stay empty forever.
    const touches = [0, 0, 0, 1, 1, 2, 2, 0, 1, 3];
    const contactIds = new Map<number, string>();
    const nContacts = Math.floor((nOpps * 8) / 10);
    for (let start = 0; start < nContacts; start += 500) {
      const rows: string[] = [];
      const params: unknown[] = [];
      for (let i = start; i < Math.min(start + 500, nContacts); i++) {
        const id = crypto.randomUUID();
        contactIds.set(i, id);
        const base = params.length;
        rows.push(`($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, 'fr')`);
        params.push(id, session.workspaceId, `contact${i}@client-${i % 400}.example.com`, `Contact ${i}`);
      }
      await conn.query(
        `insert into contacts (id, workspace_id, email, full_name, locale) values ${rows.join(', ')}`,
        params,
      );
    }
    const ids: string[] = [];
    const CHUNK = 250;
    for (let start = 0; start < nOpps; start += CHUNK) {
      const rows: string[] = [];
      const params: unknown[] = [];
      for (let i = start; i < Math.min(start + CHUNK, nOpps); i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        const base = params.length;
        rows.push(
          `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}::uuid, ` +
          `$${base + 6}, $${base + 7}::int, now() - ($${base + 8}::int || ' days')::interval, ` +
          `$${base + 9}::text, $${base + 10}::text, $${base + 11}::int)`,
        );
        const recent = i % 10 === 9; // TOO_SOON slice
        params.push(
          id, session.workspaceId, 'ref-load-' + i, clients[i % clients.length]!, contactIds.get(i) ?? null,
          'Proposition ' + i, 500_000 + (i % 900) * 1000, recent ? i % 2 : 14 + (i % 70),
          stages[i % stages.length]!, 'treatment', touches[i % touches.length]!,
        );
      }
      await conn.query(
        `insert into opportunities (id, workspace_id, external_ref, client_name, contact_id, title,
                                    amount_cents, sent_at, stage, arm, touch_count)
         values ${rows.join(', ')}`,
        params,
      );
    }
    const oppsMs = Date.now() - t0;

    const t1 = Date.now();
    for (let start = 0; start < nSignals; start += 500) {
      const rows: string[] = [];
      const params: unknown[] = [];
      for (let i = start; i < Math.min(start + 500, nSignals); i++) {
        const base = params.length;
        rows.push(
          `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::text, now() - ($${base + 4}::int || ' hours')::interval, 'load')`,
        );
        params.push(session.workspaceId, ids[i % ids.length]!, i % 2 === 0 ? 'email_open' : 'link_click', (i % 24) * 30);
      }
      await conn.query(
        `insert into signal_events (workspace_id, opportunity_id, kind, occurred_at, source) values ${rows.join(', ')}`,
        params,
      );
    }
    const signalsMs = Date.now() - t1;

    // The production import pipeline over `importRows` synthetic CSV rows.
    let importMs: number | null = null;
    let importedRows = 0;
    if (body.importRows) {
      const n = Math.min(body.importRows, 10_000);
      const header = 'Client,Proposition,Montant,Date envoi,Etape\n';
      const lines = Array.from({ length: n }, (_, i) =>
        `"Client import ${i}","Devis ${i}","${1_000 + (i % 5000)}","${new Date(Date.now() - (i % 60) * 86400000).toISOString().slice(0, 10)}","proposal_sent"`).join('\n');
      const csv = header + lines + '\n';
      const t2 = Date.now();
      const parsed = parseCsvBuffer(Buffer.from(csv, 'utf8'));
      const mapping = detectMapping(parsed.headers);
      if (!isMappingUsable(mapping).ok) {
        return NextResponse.json({ error: 'mapping_failed', headers: parsed.headers });
      }
      importedRows = parsed.rows.length;
      await conn.query(
        `insert into imports (id, workspace_id, uploaded_by, filename, row_count, mapping, status, staged_rows, headers, encoding)
         values ($1::uuid, $2::uuid, $3::uuid, 'load.csv', $4, $5::jsonb, 'parsed', $6::jsonb, $7::jsonb, $8)`,
        [crypto.randomUUID(), session.workspaceId, session.userId, parsed.rows.length,
         JSON.stringify(mapping), JSON.stringify(parsed.rows.slice(0, 200)), JSON.stringify(parsed.headers), parsed.encoding],
      );
      importMs = Date.now() - t2;
    }

    // Sans statistiques le planner PGlite choisit des nested loops catastrophiques
    // (count 7 s → 26 ms après ANALYZE). Obligatoire après tout bulk insert.
    const analyzeMs = Date.now();
    await conn.exec('analyze');
    const analyzeDone = Date.now() - analyzeMs;

    const counted = await conn.query<{ opps: number; signals: number }>(
      `select (select count(*)::int from opportunities where workspace_id = $1::uuid) as opps,
              (select count(*)::int from signal_events se
                 join opportunities o on o.id = se.opportunity_id
                where o.workspace_id = $1::uuid) as signals`,
      [session.workspaceId],
    );
    return NextResponse.json({
      ok: true, opportunities: counted.rows[0]!.opps, signals: counted.rows[0]!.signals,
      analyzeMs: analyzeDone,
      seededMs: { opportunities: oppsMs, signals: signalsMs },
      import: importMs === null ? null : { rows: importedRows, ms: importMs },
    });
  });
}
