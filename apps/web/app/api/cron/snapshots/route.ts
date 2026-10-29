import { NextResponse } from 'next/server';
import { asAdmin } from '../../../../lib/db';
import { runWeeklySnapshots, readResults } from '@rros/db/measurement';
import { renderWeeklyEmail } from '@rros/domain/measurement/weeklyEmail';
import { defaultEmailProvider } from '@rros/domain/sending/providers/index';
import { enqueueWebhook } from '@rros/db/team';
import { jobStart, jobFinish } from '@rros/db/jobs';
import { randomUUID } from 'node:crypto';

export const dynamic = 'force-dynamic';

/**
 * Monday 03:00 — the weekly measurement.
 *
 * Two jobs in one invocation because they share the cohort: refresh every running
 * experiment, then mail each owner three lines. Idempotent: running it twice
 * rewrites the same rows and sends the same email twice, which is why the mail is
 * only sent when `?mail=1` is explicitly asked for by the scheduler.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const runId = await asAdmin((c) => jobStart(c, 'cron.weekly'));

  const started = Date.now();
  const withMail = new URL(req.url).searchParams.get('mail') === '1';

  const result = await asAdmin((db) => runWeeklySnapshots(db, { now: new Date() }));

  let mailed = 0;
  if (withMail) {
    const owners = await asAdmin((db) =>
      db.query<{ workspace_id: string; email: string | null; name: string; locale: string }>(
        `select w.id as workspace_id, u.email, w.name, w.locale
           from workspaces w
           left join users u on u.workspace_id = w.id and u.role = 'owner'
          where w.deleted_at is null`,
      ),
    );
    const provider = defaultEmailProvider();
    for (const o of owners.rows) {
      if (!o.email) continue;
      const payload = await asAdmin((db) =>
        readResults(db, { workspaceId: o.workspace_id, locale: o.locale === 'en' ? 'en' : 'fr' }),
      );
      if (!payload) continue;
      const week = payload.weeks.at(-1);
      const mail = renderWeeklyEmail({
        workspaceName: o.name,
        locale: o.locale === 'en' ? 'en' : 'fr',
        weekStart: payload.weekStart,
        nReplies: week?.treatment.nReplies ?? 0,
        nWon: week?.treatment.nWon ?? 0,
        revenueCents: week?.treatment.revenueCents ?? 0,
        headline: payload.headline.text,
        queueSize: 0,
        holdoutCount: payload.holdoutCount,
      });
      const out = await provider.send({
        to: o.email,
        subject: mail.subject,
        body: mail.text,
        idempotencyKey: `weekly:${o.workspace_id}:${payload.weekStart}`,
      });
      if (out.ok) mailed += 1;
    }
  }

  // weekly.snapshot webhook for every workspace that asked for it.
  const subs = await asAdmin((c) =>
    c.query<{ workspace_id: string }>(
      `select distinct workspace_id from webhook_endpoints
        where revoked_at is null and disabled_at is null and 'weekly.snapshot' = any(events)`,
    ),
  );
  for (const row of subs.rows) {
    await asAdmin((c) => enqueueWebhook(c, row.workspace_id, 'weekly.snapshot', {
      id: randomUUID(), event: 'weekly.snapshot', week: new Date().toISOString().slice(0, 10),
    }));
  }
  await asAdmin((c) => jobFinish(c, runId, result.failed === 0 ? 'ok' : 'error', mailed));

  return NextResponse.json({
    ok: result.failed === 0,
    ...result,
    mailed,
    durationMs: Date.now() - started,
  });
}
