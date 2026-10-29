import { NextResponse } from 'next/server';
import { asAdmin, getDb } from '../../../../lib/db';
import { purgeExpiredWorkspaces } from '@rros/db/gdpr';
import { jobStart, jobFinish } from '@rros/db/jobs';
import { log } from '../../../../lib/obs';

export const dynamic = 'force-dynamic';

/**
 * Nightly hard purge: every workspace whose 30-day soft-delete window is over
 * loses every row, table by table, audit_log included. The report counts rows
 * — it never lists them.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const db = await getDb();
  const runId = await asAdmin((c) => jobStart(c, 'cron.purge'));
  const reports = await asAdmin((c) => purgeExpiredWorkspaces(c));
  await asAdmin((c) => jobFinish(c, runId, 'ok', reports.length));
  log('info', { job: 'cron.purge', count: reports.length, code: 'workspaces_purged' });
  return NextResponse.json({ ok: true, purged: reports.length, reports });
}
