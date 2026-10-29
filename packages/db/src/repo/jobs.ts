import type { Db } from '../client.ts';

/**
 * Cron heartbeats: every job writes a job_runs row (start, end, status,
 * count). The deep health endpoint alerts when any cron is older than 2× its
 * interval — "unattended for a year" starts with knowing what stopped.
 */
export interface JobRun {
  id: number;
  job: string;
  workspaceId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: 'running' | 'ok' | 'error';
  count: number;
  error: string | null;
}

export async function jobStart(db: Db, job: string, workspaceId: string | null = null): Promise<number> {
  const r = await db.query<{ id: number }>(
    `insert into job_runs (job, workspace_id) values ($1::text, $2::uuid) returning id`,
    [job, workspaceId],
  );
  return Number(r.rows[0]!.id);
}

export async function jobFinish(
  db: Db, runId: number, status: 'ok' | 'error', count: number, error?: string,
): Promise<void> {
  await db.query(
    `update job_runs set finished_at = now(), status = $2::text, count = $3::int, error = $4::text
      where id = $1::bigint`,
    [runId, status, count, error?.slice(0, 500) ?? null],
  );
}

/** Last finished run of each cron job (for /api/health/deep and /admin/ops). */
export async function lastRuns(db: Db): Promise<{ job: string; lastOkAt: Date | null; lastStatus: string | null }[]> {
  const r = await db.query<{ job: string; last_ok_at: string | null; last_status: string | null }>(
    `select job,
            max(case when status = 'ok' then finished_at end)::text as last_ok_at,
            (select status::text from job_runs j2
              where j2.job = j.job and j2.finished_at is not null
              order by started_at desc limit 1) as last_status
       from job_runs j
      group by job`,
  );
  return r.rows.map((row) => ({
    job: row.job,
    lastOkAt: row.last_ok_at ? new Date(row.last_ok_at) : null,
    lastStatus: row.last_status,
  }));
}

/** Cron intervals (seconds) — 2× any interval without a run means alert. */
export const CRON_INTERVALS_S: Record<string, number> = {
  'queue.generate': 24 * 3600,
  'cron.send': 600,
  'cron.sync': 600,
  'cron.retention': 24 * 3600,
  'cron.webhooks': 60,
  'cron.weekly': 7 * 24 * 3600,
  'cron.purge': 24 * 3600,
};

export interface HeartbeatAlert {
  job: string;
  lastOkAt: Date | null;
  overdueByS: number;
}

export function staleJobs(
  runs: { job: string; lastOkAt: Date | null }[],
  now: Date = new Date(),
): HeartbeatAlert[] {
  const alerts: HeartbeatAlert[] = [];
  for (const [job, intervalS] of Object.entries(CRON_INTERVALS_S)) {
    const run = runs.find((r) => r.job === job);
    const last = run?.lastOkAt;
    if (!last) {
      // A job that has NEVER run only alerts once it should plausibly have run.
      continue;
    }
    const ageS = (now.getTime() - last.getTime()) / 1000;
    if (ageS > 2 * intervalS) alerts.push({ job, lastOkAt: last, overdueByS: Math.round(ageS - 2 * intervalS) });
  }
  return alerts;
}
