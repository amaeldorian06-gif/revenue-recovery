import { NextResponse } from 'next/server';
import { asAdmin, getDb } from '../../../../lib/db';
import { jobStart, jobFinish } from '@rros/db/jobs';
import { purgeOldBodies } from '@rros/db/inbox';

export const dynamic = 'force-dynamic';

/**
 * Nightly retention job: bodies and snippets older than 90 days are purged
 * (workspaces that store bodies too — privacy floor applies to everyone).
 * Bearer CRON_SECRET only. Logs counts, never contents.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const runId = await asAdmin((c) => jobStart(c, 'cron.retention'));
  const db = await getDb();
  const result = await asAdmin((conn) => purgeOldBodies(conn));
  // Sessions révocables (0010) : les lignes expirées depuis > 30 jours
  // quittent la base — la table reste un journal court, pas un registre.
  const sessions = await asAdmin((conn) =>
    conn.query<{ n: string }>(
      `with gone as (delete from sessions where expires_at < now() - interval '30 days' returning 1)
       select count(*)::text as n from gone`,
    ),
  );
  await asAdmin((c) => jobFinish(c, runId, 'ok', 0));

  return NextResponse.json({ ok: true, ...result, sessionsPurged: Number(sessions.rows[0]?.n ?? 0) });
}
