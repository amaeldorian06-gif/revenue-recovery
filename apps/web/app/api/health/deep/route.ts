import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { lastRuns, staleJobs } from '@rros/db/jobs';

export const dynamic = 'force-dynamic';

/**
 * Deep health: DB reachable, queue depth, last cron runs — and an explicit
 * alert list when any cron is overdue (2× its interval). 503 when anything
 * is wrong, so a dumb uptime monitor is enough to page a human.
 */
export async function GET() {
  try {
    const out = await asAdmin(async (db) => {
      const dbOk = (await db.query<{ ok: number }>('select 1 as ok')).rows[0]?.ok === 1;
      const queue = await db.query<{ n: number }>(
        `select count(*)::int as n from recommendations where acted = false and generated_for = current_date`,
      );
      const runs = await lastRuns(db);
      const alerts = staleJobs(runs);
      return { dbOk, queueDepth: queue.rows[0]?.n ?? 0, runs, alerts };
    });
    const healthy = out.dbOk && out.alerts.length === 0;
    return NextResponse.json({
      status: healthy ? 'ok' : 'degraded',
      db: out.dbOk,
      queueDepth: out.queueDepth,
      crons: out.runs.map((r) => ({ job: r.job, lastOkAt: r.lastOkAt?.toISOString() ?? null, status: r.lastStatus })),
      alerts: out.alerts.map((a) => ({ job: a.job, overdueByS: a.overdueByS })),
    }, { status: healthy ? 200 : 503 });
  } catch (err) {
    return NextResponse.json(
      { status: 'error', message: err instanceof Error ? err.message.slice(0, 200) : 'error' },
      { status: 503 },
    );
  }
}
