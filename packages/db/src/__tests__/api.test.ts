/**
 * Phase 08 — public API v1: keys, scopes, plan gates, rate limit, idempotency,
 * and the "the API cannot send" invariant (criterion 4 by source inspection).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  createApiKey, verifyApiKey, revokeApiKey, checkRateLimit, RATE_LIMIT_PER_MIN,
} from '../repo/team.ts';
import { scopeAllowed, scopesForPlan } from '../../../domain/src/authz/scopes.ts';
import { nextDueAction } from '../repo/actions.ts';

let db: Db;
let ws: { workspaceId: string; userId: string };

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  ws = await createWorkspaceWithOwner(db, { email: 'owner@agence.fr', workspaceName: 'Agence API', locale: 'fr' });
  await db.query(`update workspaces set plan = 'scale' where id = $1::uuid`, [ws.workspaceId]);
});

describe('api keys — storage and verification', () => {
  it('creates rrs_live_ keys, stores ONLY the sha-256 and an 8-char prefix', async () => {
    const key = await createApiKey(db, ws.workspaceId, { name: 'CRM', scopes: ['read:opportunities'] });
    expect(key.key).toMatch(/^rrs_live_[A-Za-z0-9]{32}$/);
    expect(key.prefix).toBe(key.key.slice(0, 8));
    const rows = await db.query<{ key_hash: string; prefix: string }>(
      'select key_hash, prefix from api_keys where workspace_id = $1::uuid', [ws.workspaceId],
    );
    expect(rows.rows[0]!.prefix).toBe(key.prefix);
    // No plaintext anywhere: the hash is 64 hex chars, not the key.
    expect(rows.rows[0]!.key_hash).not.toContain('rrs_');
    expect(rows.rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the bearer and rejects unknown, malformed, revoked keys', async () => {
    const key = await createApiKey(db, ws.workspaceId, { name: 'CRM', scopes: ['read:results'] });
    const auth = await verifyApiKey(db, key.key);
    expect(auth).toMatchObject({ workspaceId: ws.workspaceId, plan: 'scale' });
    expect(await verifyApiKey(db, 'rrs_live_totallybogus000000000000000000000')).toBeNull();
    expect(await verifyApiKey(db, key.key.slice(0, 10))).toBeNull();
    await revokeApiKey(db, ws.workspaceId, key.id);
    expect(await verifyApiKey(db, key.key)).toBeNull();
  });

  it('a soft-deleted workspace kills its keys instantly (plan checked per request)', async () => {
    const key = await createApiKey(db, ws.workspaceId, { name: 'CRM', scopes: ['read:opportunities'] });
    expect((await verifyApiKey(db, key.key))?.plan).toBe('scale');
    await db.query(`update workspaces set deleted_at = now() where id = $1::uuid`, [ws.workspaceId]);
    expect(await verifyApiKey(db, key.key)).toBeNull();
  });
});

describe('scopes × plans (criterion 3, decision layer)', () => {
  it('starter: none; growth: read-only; scale: read+write', () => {
    expect(scopesForPlan('starter')).toEqual([]);
    expect(scopesForPlan('growth')).toEqual(['read:opportunities', 'read:results']);
    expect(scopesForPlan('scale')).toContain('write:actions');
  });

  it('a Growth key calling the write scope gets PLAN_FEATURE_UNAVAILABLE even with the scope on the key', () => {
    const verdict = scopeAllowed('growth', ['read:opportunities', 'write:actions'], 'write:actions');
    expect(verdict).toEqual({ allowed: false, reasonCode: 'PLAN_FEATURE_UNAVAILABLE' });
  });

  it('a Scale key with write scope is allowed', () => {
    expect(scopeAllowed('scale', ['write:actions'], 'write:actions').allowed).toBe(true);
  });
});

describe('the API cannot send (criterion 4)', () => {
  it('the string "approved" never appears in the v1 actions handler', () => {
    const src = readFileSync(`${process.cwd()}/apps/web/app/api/v1/actions/route.ts`, 'utf8');
    expect(src.includes('approved'), 'the API can never approve').toBe(false);
  });

  it('the replies handler only ever READS qualified actions to cancel them, never sets them', () => {
    const src = readFileSync(`${process.cwd()}/apps/web/app/api/v1/replies/route.ts`, 'utf8');
    // No assignment of the qualified state — only the IN-list cancellation read.
    expect(/status\s*=\s*'approved'/.test(src)).toBe(false);
    expect(src.includes("status in ('approved', 'draft')")).toBe(true);
  });

  it('a draft created by the API is invisible to the send job', async () => {
    // Seed a dossier, create an action exactly as POST /v1/actions does.
    const contact = await db.query<{ id: string }>(
      `insert into contacts (workspace_id, email) values ($1::uuid, 'api@test.fr') returning id`, [ws.workspaceId],
    );
    const opp = await db.query<{ id: string }>(
      `insert into opportunities (workspace_id, external_ref, client_name, contact_id, title, amount_cents, arm, stage, sent_at)
       values ($1::uuid, 'ref-api', 'Client API', $2::uuid, 'Devis', 100000, 'treatment', 'proposal_sent', now())
       returning id`, [ws.workspaceId, contact.rows[0]!.id],
    );
    await db.query(
      `insert into actions (workspace_id, opportunity_id, kind, status, actor_type, subject, draft_text)
       values ($1::uuid, $2::uuid, 'draft_generated', 'draft', 'system', 'via API', 'texte')`,
      [ws.workspaceId, opp.rows[0]!.id],
    );
    // The send job only ever picks kind='approved': a draft is never due.
    expect(await nextDueAction(db, ws.workspaceId, new Date())).toBeNull();
  });
});

describe('rate limit — 120 req/min/workspace, sliding window (criterion 5)', () => {
  it('the first calls decrement X-RateLimit-Remaining; the 121st is refused with Retry-After', async () => {
    const first = await checkRateLimit(db, ws.workspaceId, '/v1/opportunities', null);
    expect(first.ok).toBe(true);
    expect(first.remaining).toBe(RATE_LIMIT_PER_MIN - 1);
    const second = await checkRateLimit(db, ws.workspaceId, '/v1/opportunities', null);
    expect(second.remaining).toBe(RATE_LIMIT_PER_MIN - 2);

    for (let i = 0; i < RATE_LIMIT_PER_MIN - 2; i++) {
      await checkRateLimit(db, ws.workspaceId, '/v1/opportunities', null);
    }
    const overflow = await checkRateLimit(db, ws.workspaceId, '/v1/opportunities', null);
    expect(overflow.ok).toBe(false);
    expect(overflow.remaining).toBe(0);
    expect(overflow.retryAfterS).toBeGreaterThan(0);
    expect(overflow.retryAfterS).toBeLessThanOrEqual(60);
  });

  it('the window slides: requests older than 60 s stop counting', async () => {
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) {
      await checkRateLimit(db, ws.workspaceId, '/v1/results', null);
    }
    expect((await checkRateLimit(db, ws.workspaceId, '/v1/results', null)).ok).toBe(false);
    // Age every journal row beyond the window → the workspace breathes again.
    await db.query(`update api_requests set created_at = now() - interval '2 minutes' where workspace_id = $1::uuid`, [ws.workspaceId]);
    expect((await checkRateLimit(db, ws.workspaceId, '/v1/results', null)).ok).toBe(true);
  });

  it('counts per WORKSPACE, not per key', async () => {
    const k1 = await createApiKey(db, ws.workspaceId, { name: 'A', scopes: ['read:opportunities'] });
    const k2 = await createApiKey(db, ws.workspaceId, { name: 'B', scopes: ['read:opportunities'] });
    for (let i = 0; i < RATE_LIMIT_PER_MIN / 2 + 1; i++) await checkRateLimit(db, ws.workspaceId, '/v1/opportunities', k1.id);
    for (let i = 0; i < RATE_LIMIT_PER_MIN / 2 + 1; i++) await checkRateLimit(db, ws.workspaceId, '/v1/opportunities', k2.id);
    expect((await checkRateLimit(db, ws.workspaceId, '/v1/opportunities', k1.id)).ok).toBe(false);
  });
});

describe('idempotency storage', () => {
  it('a replayed Idempotency-Key finds the stored response', async () => {
    await db.query(
      `insert into api_idempotency (workspace_id, route, idem_key, status_code, response_body)
       values ($1::uuid, '/v1/actions', 'key-1', 201, '{"id":"a1"}'::jsonb)`,
      [ws.workspaceId],
    );
    const prior = await db.query<{ status_code: number }>(
      `select status_code from api_idempotency where workspace_id = $1::uuid and route = '/v1/actions' and idem_key = 'key-1'`,
      [ws.workspaceId],
    );
    expect(prior.rows[0]?.status_code).toBe(201);
    // A different key is a different request.
    const none = await db.query(
      `select 1 from api_idempotency where workspace_id = $1::uuid and idem_key = 'key-2'`, [ws.workspaceId],
    );
    expect(none.rows.length).toBe(0);
  });
});
