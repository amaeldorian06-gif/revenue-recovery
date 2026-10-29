import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { asAdmin } from '../../../../lib/db';
import { dueDeliveries, duePending, recordDeliveryAttempt, scheduleRetry } from '@rros/db/team';
import { signPayload, RETRY_DELAYS_S } from '@rros/domain/webhooks/sign';
import { isDeliverableUrl } from '@rros/domain/webhooks/ssrf';
import { jobStart, jobFinish } from '@rros/db/jobs';
import { log } from '../../../../lib/obs';

export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 5_000;

/**
 * Webhook dispatcher. Every delivery is signed `t=<ts>,v1=<hmac>` over
 * `timestamp.body`, carries X-RRS-Id for idempotency, times out at 5 s, and
 * retries 10 s / 60 s / 300 s before the dead-letter. The SSRF guard runs
 * again at delivery time — a URL registered before a hardening fix does not
 * stay deliverable by seniority.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const db = await getDb();
  const runId = await asAdmin((c) => jobStart(c, 'cron.webhooks'));
  const dev = process.env.RROS_DEV_SEED === '1';
  // ?force=1 — ops replay: process every pending delivery now, ignoring the
  // backoff schedule (documented in RUNBOOK.md, "rejouer un cron").
  const force = new URL(req.url).searchParams.get('force') === '1';
  const due = await asAdmin((c) => (force ? duePending(c) : dueDeliveries(c)));
  let delivered = 0;
  let failed = 0;
  let dead = 0;
  let disabled = 0;

  for (const d of due) {
    const guard = isDeliverableUrl(d.url, { allowInsecureLoopback: dev });
    if (!guard.allowed) {
      await asAdmin((c) => recordDeliveryAttempt(c, d.id, d.endpointId, { ok: false, error: `ssrf_blocked:${guard.reason}` }));
      failed += 1;
      continue;
    }
    const body = JSON.stringify(d.payload);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rrs-signature': signPayload(d.secret, body),
          'x-rrs-id': d.id,
          'x-rrs-event': d.event,
        },
        body,
        signal: controller.signal,
      });
      if (res.ok) {
        await asAdmin((c) => recordDeliveryAttempt(c, d.id, d.endpointId, { ok: true, statusCode: res.status }));
        delivered += 1;
      } else {
        const outcome = await asAdmin((c) =>
          recordDeliveryAttempt(c, d.id, d.endpointId, { ok: false, statusCode: res.status, error: `http_${res.status}` }));
        tally(outcome);
        if (outcome === 'retry') {
          await asAdmin((c) => scheduleRetry(c, d.id, RETRY_DELAYS_S[Math.min(d.attempts, RETRY_DELAYS_S.length - 1)]!));
        }
      }
    } catch (err) {
      const outcome = await asAdmin((c) =>
        recordDeliveryAttempt(c, d.id, d.endpointId, { ok: false, error: err instanceof Error ? err.message : 'error' }));
      tally(outcome);
      if (outcome === 'retry') {
        await asAdmin((c) => scheduleRetry(c, d.id, RETRY_DELAYS_S[Math.min(d.attempts, RETRY_DELAYS_S.length - 1)]!));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  function tally(outcome: 'succeeded' | 'retry' | 'dead' | 'disabled') {
    if (outcome === 'dead') dead += 1;
    else if (outcome === 'disabled') disabled += 1;
    else failed += 1;
  }

  await asAdmin((c) => jobFinish(c, runId, 'ok', delivered));
  log('info', { job: 'cron.webhooks', count: delivered, code: `f${failed}/d${dead}/x${disabled}` });
  return NextResponse.json({ ok: true, delivered, failed, dead, disabled });
}
