import { randomInt } from 'node:crypto';
import type { Db } from '../client.ts';
import type { ImportResult, NormalisedOpportunity } from '../../../domain/src/import/pipeline.ts';

/**
 * Persistence of an import. The pure pipeline decides *what*; this module decides
 * *how*, and owns the two rules that must survive a buggy caller:
 *   - the arm is assigned once, with a CSPRNG, and only for new rows;
 *   - an existing row is never moved between arms (the trigger backs this up).
 */

export interface CommitOptions {
  workspaceId: string;
  userId: string | null;
  filename: string;
  holdoutRate: number;
  mapping: unknown;
  /** Hard cap from the plan; the caller has already checked entitlements. */
  maxRows: number;
}

export interface CommitOutcome {
  importId: string;
  created: number;
  updated: number;
  skipped: number;
  holdoutCreated: number;
}

const CHUNK = 500;

export function assignArm(holdoutRate: number): 'treatment' | 'holdout' {
  return randomInt(0, 1_000_000) / 1_000_000 < holdoutRate ? 'holdout' : 'treatment';
}

export async function commitImport(
  db: Db,
  result: ImportResult & { arms: Map<string, 'treatment' | 'holdout'> },
  opts: CommitOptions,
): Promise<CommitOutcome> {
  const rows = result.toCreate.slice(0, opts.maxRows);

  await db.exec('begin');
  try {
    const imp = await db.query<{ id: string }>(
      `insert into imports (workspace_id, uploaded_by, filename, row_count, mapping, status)
       values ($1::uuid, $2, $3, $4, $5::jsonb, 'committed') returning id`,
      [opts.workspaceId, opts.userId, opts.filename, result.stats.rows, JSON.stringify(opts.mapping)],
    );
    const importId = imp.rows[0]!.id;

    let holdoutCreated = 0;

    // Contacts first: one upsert per distinct email.
    const emails = new Map<string, string>();
    for (const o of rows) {
      if (!o.contactEmail) continue;
      emails.set(o.contactEmail, o.clientName);
    }
    for (const [email, company] of emails) {
      await db.query(
        `insert into contacts (workspace_id, email, company)
         values ($1::uuid, $2, $3)
         on conflict (workspace_id, email) do update set company = coalesce(contacts.company, excluded.company)`,
        [opts.workspaceId, email, company],
      );
    }

    if (emails.size > 0) {
      const found = await db.query<{ id: string; email: string }>(
        `select id, email from contacts where workspace_id = $1::uuid and email = any($2::text[])`,
        [opts.workspaceId, [...emails.keys()]],
      );
      for (const c of found.rows) emails.set(c.email, c.id);
    }

    // Create in chunks so a 5 000-row file never times out a single transaction.
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      for (const o of chunk) {
        const arm = result.arms.get(armKeyOf(o)) ?? assignArm(opts.holdoutRate);
        if (arm === 'holdout') holdoutCreated += 1;
        const contactId = o.contactEmail ? emails.get(o.contactEmail) ?? null : null;
        const looksLikeUuid = contactId !== null && /^[0-9a-f-]{36}$/.test(contactId);
        await db.query(
          `insert into opportunities
             (workspace_id, external_ref, client_name, contact_id, title, amount_cents,
              stage, sent_at, last_touch_at, touch_count, arm, arm_method, source, raw)
           values ($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8::timestamptz,$9::timestamptz,$10,$11,'random','import',$12::jsonb)
           on conflict (workspace_id, external_ref) where external_ref is not null do nothing`,
          [
            opts.workspaceId,
            o.externalRef,
            o.clientName,
            looksLikeUuid ? contactId : null,
            o.title,
            o.amountCents,
            o.stage,
            o.sentAt,
            o.lastTouchAt,
            o.touchCount,
            arm,
            JSON.stringify({ imported: true }),
          ],
        );
      }
    }

    // Updates: mutable fields only. `arm` is deliberately absent from the SET list.
    for (const u of result.toUpdate) {
      const p = u.patch;
      await db.query(
        `update opportunities set
           client_name = coalesce($2, client_name),
           title = coalesce($3, title),
           amount_cents = coalesce($4, amount_cents),
           stage = coalesce($5, stage),
           sent_at = coalesce($6::timestamptz, sent_at),
           last_touch_at = coalesce($7::timestamptz, last_touch_at)
         where id = $1::uuid and workspace_id = $8::uuid`,
        [
          u.id, p.clientName ?? null, p.title ?? null, p.amountCents ?? null,
          p.stage ?? null, p.sentAt ?? null, p.lastTouchAt ?? null, opts.workspaceId,
        ],
      );
    }

    await db.query(
      `update imports set imported_count = $2, updated_count = $3, skipped_count = $4, errors = $5::jsonb
       where id = $1::uuid`,
      [importId, rows.length, result.toUpdate.length, result.skipped.length,
        JSON.stringify(result.skipped.slice(0, 200))],
    );

    // Data minimisation: once committed, the raw staged copy of the file has
    // served its purpose. Only the metadata (counts, mapping, errors) stays.
    await db.query(
      `update imports set staged_rows = null, headers = null where id = $1::uuid`,
      [importId],
    );

    // Usage counter: a proposal counts once per period, even if re-imported.
    const period = new Date();
    const periodStart = `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, '0')}-01`;
    await db.query(
      `insert into usage_counters (workspace_id, period_start, proposals_tracked)
       values ($1::uuid, $2::date, $3)
       on conflict (workspace_id, period_start)
       do update set proposals_tracked = usage_counters.proposals_tracked + excluded.proposals_tracked,
                     updated_at = now()`,
      [opts.workspaceId, periodStart, rows.length],
    );

    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2, 'import.committed', 'import', $3::text, $4::jsonb)`,
      [opts.workspaceId, opts.userId, importId,
        JSON.stringify({ created: rows.length, updated: result.toUpdate.length, skipped: result.skipped.length })],
    );

    await db.exec('commit');
    // Après un bulk import, rafraîchir les statistiques : sans ANALYZE le planner
    // PGlite dégrade radicalement ses plans (count 7 s → 26 ms après analyse).
    if (rows.length >= 500) await db.exec('analyze');
    return {
      importId,
      created: rows.length,
      updated: result.toUpdate.length,
      skipped: result.skipped.length,
      holdoutCreated,
    };
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}

function armKeyOf(o: NormalisedOpportunity): string {
  if (o.externalRef) return `ref:${o.externalRef.trim().toLowerCase()}`;
  const day = o.sentAt.slice(0, 10);
  const name = o.clientName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `nat:${name}:${o.amountCents}:${day}`;
}

export interface ExistingRow {
  id: string;
  externalRef: string | null;
  clientName: string;
  amountCents: number;
  sentAt: string;
}

export async function loadExisting(db: Db, workspaceId: string): Promise<ExistingRow[]> {
  const res = await db.query<{ id: string; external_ref: string | null; client_name: string; amount_cents: string; sent_at: string }>(
    `select id, external_ref, client_name, amount_cents, sent_at
     from opportunities where workspace_id = $1::uuid`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    externalRef: r.external_ref,
    clientName: r.client_name,
    amountCents: Number(r.amount_cents),
    sentAt: new Date(r.sent_at).toISOString(),
  }));
}

export interface PortfolioSummary {
  total: number;
  unanswered: number;
  exposedCents: number;
  holdout: number;
  byStage: Record<string, number>;
}

/** The "aha" figures of the calibration screen. One query, no N+1. */
export async function portfolioSummary(db: Db, workspaceId: string): Promise<PortfolioSummary> {
  const res = await db.query<{ total: number; unanswered: number; exposed: string; holdout: number }>(
    `select count(*)::int as total,
            count(*) filter (where touch_count = 0 and reply_received_at is null)::int as unanswered,
            coalesce(sum(amount_cents) filter (where reply_received_at is null and status = 'open'), 0)::text as exposed,
            count(*) filter (where arm = 'holdout')::int as holdout
     from opportunities where workspace_id = $1::uuid`,
    [workspaceId],
  );
  const stages = await db.query<{ stage: string; n: number }>(
    `select stage, count(*)::int as n from opportunities where workspace_id = $1::uuid group by stage`,
    [workspaceId],
  );
  const row = res.rows[0]!;
  return {
    total: row.total,
    unanswered: row.unanswered,
    exposedCents: Number(row.exposed),
    holdout: row.holdout,
    byStage: Object.fromEntries(stages.rows.map((s) => [s.stage, s.n])),
  };
}
