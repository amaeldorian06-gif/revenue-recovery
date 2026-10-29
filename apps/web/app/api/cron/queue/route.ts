import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { asAdmin } from '../../../../lib/db';
import { generateQueue, expireWindows } from '@rros/db/queue';
import { enqueueWebhook } from '@rros/db/team';
import { jobStart, jobFinish } from '@rros/db/jobs';

export const dynamic = 'force-dynamic';

/**
 * Daily generation, 06:00 workspace time. Idempotent: running it twice is
 * harmless, which is what makes a cron safe to retry.
 *
 * Authenticated with a shared secret, never with a session: a cron has no user.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const runId = await asAdmin((c) => jobStart(c, 'queue.generate'));

  const started = Date.now();
  const workspaces = await asAdmin((db) =>
    db.query<{ id: string }>(`select id from workspaces where deleted_at is null`),
  );

  let generated = 0;
  let failed = 0;
  let expired = 0;
  for (const w of workspaces.rows) {
    try {
      // Window closed (gate 7): the opportunity leaves the pipeline with a
      // status and an event — the customer's CRM keeps the history, the
      // webhooks subscriber learns why the dossier vanished from the queue.
      expired += await asAdmin((db) =>
        expireWindows(db, w.id, (opportunityId) =>
          enqueueWebhook(db, w.id, 'opportunity.expired', {
            id: randomUUID(), event: 'opportunity.expired',
            opportunityId, status: 'expired',
          })),
      );
      await asAdmin((db) => generateQueue(db, { workspaceId: w.id, date: new Date() }));
      generated += 1;
    } catch {
      failed += 1;
    }
  }

  await asAdmin((c) => jobFinish(c, runId, 'ok', 0));

  return NextResponse.json({
    ok: failed === 0,
    workspaces: workspaces.rows.length,
    generated,
    expired,
    failed,
    durationMs: Date.now() - started,
  });
}
