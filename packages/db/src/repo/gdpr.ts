import type { Db } from '../client.ts';

/**
 * GDPR machinery — export and deletion. Two rules drive everything:
 *  1. The export contains EVERY row of the workspace and NOT ONE row of
 *     another workspace (criterion 7 is a cross-tenant assertion).
 *  2. Deletion purges in FK order across every table, audit_log included —
 *     the DPA documents a 12-month operational exception for anonymised
 *     audit rows, which this job honours by deleting, never by keeping.
 */

/** Every tenant table with its FK order (children before parents). */
export const TENANT_TABLES: readonly string[] = [
  'webhook_deliveries',
  'webhook_endpoints',
  'api_requests',
  'api_keys',
  'api_idempotency',
  'export_requests',
  'send_attempts',
  'actions',
  'recommendations',
  'signal_events',
  'snapshots',
  'attribution_results',
  'usage_counters',
  'mail_messages',
  'mailbox_connections',
  'funnel_events',
  'onboarding_state',
  'audit_log',
  'opportunities',
  'imports',
  'contacts',
  'experiments',
  'invitations',
  'users',
  'job_runs',
  'workspaces',
];

export interface WorkspaceSnapshot {
  table: string;
  rows: Record<string, unknown>[];
}

/** Read every row of every tenant table for one workspace. */
export async function collectWorkspace(db: Db, workspaceId: string): Promise<WorkspaceSnapshot[]> {
  const out: WorkspaceSnapshot[] = [];
  for (const table of TENANT_TABLES) {
    // Table names come from the constant above, never from user input.
    const r = await db.query<Record<string, unknown>>(
      `select * from ${table} where ${table === 'workspaces' ? 'id' : 'workspace_id'} = $1::uuid`,
      [workspaceId],
    );
    out.push({ table, rows: r.rows });
  }
  return out;
}

export async function markDeleted(db: Db, workspaceId: string, purgeAt: Date): Promise<void> {
  // Soft delete NOW: all access revoked (the session check and every query
  // join on workspaces.deleted_at is null), hard purge in 30 days.
  await db.query(
    `update workspaces set deleted_at = now(), purge_at = $2::timestamptz where id = $1::uuid`,
    [workspaceId, purgeAt.toISOString()],
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
     values ($1::uuid, 'system', 'workspace.deleted', 'workspace', $1::text, $2::jsonb)`,
    [workspaceId, JSON.stringify({ purgeAt: purgeAt.toISOString() })],
  );
}

export interface PurgeReport {
  workspaceId: string;
  deleted: Record<string, number>;
}

/**
 * Hard-purge every workspace whose 30-day window is over. Children first;
 * `workspaces` last; the cascade is never trusted — each table deletes
 * explicitly so the report can show the count per table.
 */
export async function purgeExpiredWorkspaces(db: Db, now: Date = new Date()): Promise<PurgeReport[]> {
  const due = await db.query<{ id: string }>(
    `select id from workspaces where deleted_at is not null and purge_at <= $1::timestamptz`,
    [now.toISOString()],
  );
  const reports: PurgeReport[] = [];
  for (const ws of due.rows) {
    const deleted: Record<string, number> = {};
    for (const table of TENANT_TABLES) {
      if (table === 'workspaces') continue;
      const r = await db.query<{ n: number }>(
        `with gone as (delete from ${table} where workspace_id = $1::uuid returning 1)
         select count(*)::int as n from gone`,
        [ws.id],
      );
      if (r.rows[0]!.n > 0) deleted[table] = r.rows[0]!.n;
    }
    await db.query('delete from workspaces where id = $1::uuid', [ws.id]);
    reports.push({ workspaceId: ws.id, deleted });
  }
  return reports;
}

/** Used by the session layer: a deleted workspace loses all access at once. */
export async function isWorkspaceDeleted(db: Db, workspaceId: string): Promise<boolean> {
  const r = await db.query<{ deleted: boolean }>(
    'select deleted_at is not null as deleted from workspaces where id = $1::uuid',
    [workspaceId],
  );
  return r.rows[0]?.deleted === true;
}
