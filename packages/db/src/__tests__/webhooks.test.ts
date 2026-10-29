/**
 * Phase 08 — webhooks (criterion 6): enqueue per subscription, signed
 * delivery, 3 attempts then dead letter, endpoint disabled after 20
 * consecutive failures, SSRF guard on registration.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  createWebhookEndpoint, enqueueWebhook, dueDeliveries, recordDeliveryAttempt,
  scheduleRetry, listDeadDeliveries, listWebhookEndpoints,
} from '../repo/team.ts';
import { signPayload, verifySignature, RETRY_DELAYS_S } from '../../../domain/src/webhooks/sign.ts';

let db: Db;
let ws: { workspaceId: string; userId: string };

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  ws = await createWorkspaceWithOwner(db, { email: 'owner@agence.fr', workspaceName: 'Agence Hooks', locale: 'fr' });
});

const URL = 'http://127.0.0.1:3000/api/dev/hook-receiver';

describe('endpoints', () => {
  it('registers an endpoint with an encrypted secret and the SSRF guard', async () => {
    const ep = await createWebhookEndpoint(db, ws.workspaceId, URL, ['reply.received'], { devLoopback: true });
    expect(ep.secret).toMatch(/^whsec_/);
    const rows = await db.query<{ secret: string }>('select secret from webhook_endpoints where id = $1::uuid', [ep.id]);
    // Encrypted at rest: the raw secret is not in the table.
    expect(rows.rows[0]!.secret).not.toBe(ep.secret);
    expect(rows.rows[0]!.secret).toMatch(/^v1:/);
  });

  it('rejects private and plain-http URLs (SSRF guard runs at registration)', async () => {
    await expect(createWebhookEndpoint(db, ws.workspaceId, 'http://169.254.169.254/meta', ['reply.received']))
      .rejects.toThrow(/SSRF/);
    await expect(createWebhookEndpoint(db, ws.workspaceId, 'https://10.1.2.3/hook', ['reply.received']))
      .rejects.toThrow(/SSRF/);
    await expect(createWebhookEndpoint(db, ws.workspaceId, 'http://intranet.local/hook', ['reply.received']))
      .rejects.toThrow(/SSRF/);
  });
});

describe('deliveries', () => {
  it('enqueues one delivery per SUBSCRIBED endpoint, none for others', async () => {
    const sub = await createWebhookEndpoint(db, ws.workspaceId, URL, ['reply.received'], { devLoopback: true });
    const other = await createWebhookEndpoint(db, ws.workspaceId, 'https://other.example.com/hook', ['action.sent'], { devLoopback: false });
    void other;
    expect(await enqueueWebhook(db, ws.workspaceId, 'reply.received', { id: 'e1' })).toBe(1);
    expect(await enqueueWebhook(db, ws.workspaceId, 'opportunity.won', { id: 'e2' })).toBe(0);

    const due = await dueDeliveries(db);
    expect(due.length).toBe(1);
    expect(due[0]!.event).toBe('reply.received');
    expect(due[0]!.payload).toMatchObject({ id: 'e1' });
    void sub;
  });

  it('delivers signed: the signature over timestamp.body verifies with the endpoint secret', async () => {
    await createWebhookEndpoint(db, ws.workspaceId, URL, ['reply.received'], { devLoopback: true });
    await enqueueWebhook(db, ws.workspaceId, 'reply.received', { id: 'sig-1' });
    const [delivery] = await dueDeliveries(db);
    const body = JSON.stringify(delivery!.payload);
    const header = signPayload(delivery!.secret, body);
    expect(verifySignature(header, delivery!.secret, body).ok).toBe(true);
    // And a tampered payload fails — what a receiver must check.
    expect(verifySignature(header, delivery!.secret, body.replace('sig-1', 'evil')).reason).toBe('signature');
  });

  it('retries 10 s, 60 s, 300 s, then dead-letters (criterion 6)', async () => {
    await createWebhookEndpoint(db, ws.workspaceId, URL, ['reply.received'], { devLoopback: true });
    await enqueueWebhook(db, ws.workspaceId, 'reply.received', { id: 'r-1' });
    let [d] = await dueDeliveries(db);
    // Attempt 1 fails → retry in 10 s.
    expect(await recordDeliveryAttempt(db, d!.id, d!.endpointId, { ok: false, statusCode: 500, error: 'http_500' })).toBe('retry');
    await scheduleRetry(db, d!.id, RETRY_DELAYS_S[0]!);
    // Attempt 2 fails → retry in 60 s.
    [d] = await dueDeliveries(db);
    expect(d).toBeUndefined(); // next_attempt_at is in the future
    await db.query(`update webhook_deliveries set next_attempt_at = now() - interval '1 second' where attempts = 1`);
    [d] = await dueDeliveries(db);
    expect(await recordDeliveryAttempt(db, d!.id, d!.endpointId, { ok: false, statusCode: 500, error: 'http_500' })).toBe('retry');
    await scheduleRetry(db, d!.id, RETRY_DELAYS_S[1]!);
    // Attempt 3 fails → dead.
    await db.query(`update webhook_deliveries set next_attempt_at = now() - interval '1 second' where attempts = 2`);
    [d] = await dueDeliveries(db);
    expect(await recordDeliveryAttempt(db, d!.id, d!.endpointId, { ok: false, statusCode: 500, error: 'http_500' })).toBe('dead');
    const dead = await listDeadDeliveries(db, ws.workspaceId);
    expect(dead.length).toBe(1);
    expect(dead[0]!.attempts).toBe(3);
    // A dead delivery is never picked again.
    expect((await dueDeliveries(db)).length).toBe(0);
  });

  it('success resets the failure streak; 20 consecutive failures disable the endpoint', async () => {
    const ep = await createWebhookEndpoint(db, ws.workspaceId, URL, ['reply.received'], { devLoopback: true });
    // 19 failures: still alive.
    for (let i = 0; i < 19; i++) {
      await enqueueWebhook(db, ws.workspaceId, 'reply.received', { id: `f${i}` });
      const [d] = await dueDeliveries(db);
      await recordDeliveryAttempt(db, d!.id, ep.id, { ok: false, statusCode: 500, error: 'http_500' });
    }
    expect((await listWebhookEndpoints(db, ws.workspaceId))[0]!.disabledAt).toBeNull();
    // A success resets the streak…
    await enqueueWebhook(db, ws.workspaceId, 'reply.received', { id: 'ok1' });
    const [okd] = await dueDeliveries(db);
    await recordDeliveryAttempt(db, okd!.id, ep.id, { ok: true, statusCode: 200 });
    expect((await listWebhookEndpoints(db, ws.workspaceId))[0]!.failureCount).toBe(0);
    // …then 20 consecutive failures disable the endpoint and drain the pending queue.
    for (let i = 0; i < 20; i++) {
      await enqueueWebhook(db, ws.workspaceId, 'reply.received', { id: `g${i}` });
      const [d] = await dueDeliveries(db);
      if (!d) break; // endpoint disabled, queue drained
      await recordDeliveryAttempt(db, d.id, ep.id, { ok: false, statusCode: 500, error: 'http_500' });
    }
    const [after] = await listWebhookEndpoints(db, ws.workspaceId);
    expect(after!.disabledAt).not.toBeNull();
    expect(after!.disabledReason).toContain('20');
    expect((await dueDeliveries(db)).length).toBe(0);
  });
});
