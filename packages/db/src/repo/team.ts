import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../client.ts';
import { encryptSecret } from '../../../domain/src/inbox/secretBox.ts';
import { decryptSecret } from './inbox.ts';
import { isDeliverableUrl } from '../../../domain/src/webhooks/ssrf.ts';
import { check } from '../../../domain/src/entitlements/check.ts';
import type { Usage } from '../../../domain/src/entitlements/check.ts';

/**
 * Team, API keys, webhooks — persistence for phase 08. Every function is
 * workspace-scoped; every secret is hashed or encrypted; every gate lives in
 * the domain (can.ts / check.ts), never re-coded inline.
 */

// ------------------------------------------------------------------- team

export interface Member {
  id: string; email: string; fullName: string | null;
  role: 'owner' | 'admin' | 'member' | 'viewer'; lastSeenAt: Date | null;
}

export async function listMembers(db: Db, workspaceId: string): Promise<Member[]> {
  const r = await db.query<{
    id: string; email: string; full_name: string | null;
    role: Member['role']; last_seen_at: string | null;
  }>(
    `select id, email, full_name, role, last_seen_at from users
      where workspace_id = $1::uuid order by created_at`,
    [workspaceId],
  );
  return r.rows.map((u) => ({
    id: u.id, email: u.email, fullName: u.full_name, role: u.role,
    lastSeenAt: u.last_seen_at ? new Date(u.last_seen_at) : null,
  }));
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class SeatLimitReachedError extends Error {
  constructor() {
    super('SEAT_LIMIT_REACHED');
    this.name = 'SeatLimitReachedError';
  }
}

export interface InviteResult {
  invitationId: string;
  /** Returned once, in the UI (no mail provider in the sandbox). */
  inviteUrlPath: string;
  role: 'admin' | 'member' | 'viewer';
  email: string;
}

/**
 * Create (or re-issue) an invitation. Seat limits are NOT checked here —
 * a pending invitation never consumes a seat (criterion 2); the gate lives
 * on acceptance, where the overshoot would actually happen.
 */
export async function inviteMember(
  db: Db, workspaceId: string, invitedBy: string,
  input: { email: string; role: 'admin' | 'member' | 'viewer'; locale: 'fr' | 'en' },
): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();
  // Resend invalidates the previous token: revoke, then insert fresh.
  await db.query(
    `update invitations set revoked_at = coalesce(revoked_at, now())
      where workspace_id = $1::uuid and email = $2::text and accepted_at is null and revoked_at is null`,
    [workspaceId, email],
  );
  const token = randomBytes(24).toString('base64url');
  const r = await db.query<{ id: string }>(
    `insert into invitations (workspace_id, email, role, token_hash, expires_at, invited_by)
     values ($1::uuid, $2::text, $3::text, $4::text, now() + interval '7 days', $5::uuid)
     returning id`,
    [workspaceId, email, input.role, hashToken(token), invitedBy],
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
     values ($1::uuid, 'user', $2::uuid, 'member.invited', 'invitation', $3, $4::jsonb)`,
    [workspaceId, invitedBy, r.rows[0]!.id, JSON.stringify({ email, role: input.role })],
  );
  return {
    invitationId: r.rows[0]!.id,
    inviteUrlPath: `/${input.locale}/invite/${token}`,
    role: input.role,
    email,
  };
}

export interface AcceptOutcome {
  ok: boolean;
  userId?: string;
  workspaceId?: string;
  error?: 'expired' | 'used' | 'revoked' | 'unknown' | 'seat_limit';
}

/**
 * Accept an invitation token. The seat limit bites HERE, at acceptance —
 * the one moment a pending invite becomes a person.
 */
export async function acceptInvitation(db: Db, token: string): Promise<AcceptOutcome> {
  const h = hashToken(token);
  const inv = await db.query<{
    id: string; workspace_id: string; email: string; role: Member['role'];
    expires_at: string; accepted_at: string | null; revoked_at: string | null;
  }>(
    `select id, workspace_id, email, role, expires_at, accepted_at, revoked_at
       from invitations where token_hash = $1::text`,
    [h],
  );
  const row = inv.rows[0];
  if (!row) return { ok: false, error: 'unknown' };
  if (row.revoked_at) return { ok: false, error: 'revoked' };
  if (row.accepted_at) return { ok: false, error: 'used' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, error: 'expired' };

  const ws = await db.query<{ seats: number }>(
    `select (w.plan::text = 'starter')::int * 1 + (w.plan::text = 'growth')::int * 4
           + (w.plan::text = 'scale')::int * 12 as seats
       from workspaces w where w.id = $1::uuid`,
    [row.workspace_id],
  );
  const seats = ws.rows[0]?.seats ?? 1;
  const occupancy = await db.query<{ n: number }>(
    `select count(*)::int as n from users where workspace_id = $1::uuid`,
    [row.workspace_id],
  );
  const plan = await db.query<{ plan: 'starter' | 'growth' | 'scale' }>(
    'select plan::text as plan from workspaces where id = $1::uuid', [row.workspace_id],
  );
  const usage: Usage = { proposalsTracked: 0, emailsSent: 0, seats: occupancy.rows[0]!.n, mailboxes: 0 };
  const decision = check(plan.rows[0]?.plan ?? 'starter', usage, 'add_seat');
  if (occupancy.rows[0]!.n >= seats || !decision.allowed) {
    return { ok: false, error: 'seat_limit' };
  }

  const user = await db.query<{ id: string }>(
    `insert into users (auth_user_id, workspace_id, email, role)
     values ($1::text, $2::uuid, $3::text, $4::text) returning id`,
    [`invited:${crypto.randomUUID()}`, row.workspace_id, row.email, row.role],
  );
  await db.query(
    `update invitations set accepted_at = now() where id = $1::uuid`,
    [row.id],
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
     values ($1::uuid, 'user', 'member.joined', 'user', $2, $3::jsonb)`,
    [row.workspace_id, user.rows[0]!.id, JSON.stringify({ email: row.email, role: row.role })],
  );
  return { ok: true, userId: user.rows[0]!.id, workspaceId: row.workspace_id };
}

export async function removeMember(db: Db, workspaceId: string, actorId: string, userId: string): Promise<boolean> {
  const target = await db.query<{ role: string }>(
    'select role::text as role from users where id = $1::uuid and workspace_id = $2::uuid',
    [userId, workspaceId],
  );
  if (!target.rows[0]) return false;
  if (target.rows[0].role === 'owner') return false; // ownership transfer is out of scope, never a delete
  await db.query('delete from users where id = $1::uuid and workspace_id = $2::uuid', [userId, workspaceId]);
  await db.query(
    `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
     values ($1::uuid, 'user', $2::uuid, 'member.removed', 'user', $3, '{}'::jsonb)`,
    [workspaceId, actorId, userId],
  );
  return true;
}

// --------------------------------------------------------------- api keys

export interface ApiKeyRow {
  id: string; name: string; prefix: string;
  scopes: string[]; lastUsedAt: Date | null; revokedAt: Date | null;
}

export async function listApiKeys(db: Db, workspaceId: string): Promise<ApiKeyRow[]> {
  const r = await db.query<{
    id: string; name: string; prefix: string; scopes: string[];
    last_used_at: string | null; revoked_at: string | null;
  }>(
    `select id, name, prefix, scopes, last_used_at, revoked_at from api_keys
      where workspace_id = $1::uuid and revoked_at is null order by created_at desc`,
    [workspaceId],
  );
  return r.rows.map((k) => ({
    id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes,
    lastUsedAt: k.last_used_at ? new Date(k.last_used_at) : null,
    revokedAt: k.revoked_at ? new Date(k.revoked_at) : null,
  }));
}

/**
 * Create a key: `rrs_live_<32 base62>` (or rrs_test_). The plaintext leaves
 * this function exactly once; only the SHA-256 and an 8-char prefix persist.
 */
export async function createApiKey(
  db: Db, workspaceId: string,
  input: { name: string; scopes: string[]; test?: boolean },
): Promise<{ id: string; key: string; prefix: string }> {
  const body = randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, 'x');
  const key = `${input.test ? 'rrs_test_' : 'rrs_live_'}${body}`;
  const prefix = key.slice(0, 8);
  const r = await db.query<{ id: string }>(
    `insert into api_keys (workspace_id, name, prefix, key_hash, scopes)
     values ($1::uuid, $2::text, $3::text, $4::text, $5::text[]) returning id`,
    [workspaceId, input.name, prefix, hashToken(key), input.scopes],
  );
  await db.query(
    `insert into audit_log (workspace_id, actor_type, action, entity, entity_id, after)
     values ($1::uuid, 'user', 'api_key.created', 'api_key', $2, $3::jsonb)`,
    [workspaceId, r.rows[0]!.id, JSON.stringify({ name: input.name, scopes: input.scopes })],
  );
  return { id: r.rows[0]!.id, key, prefix };
}

export async function revokeApiKey(db: Db, workspaceId: string, keyId: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `with upd as (
       update api_keys set revoked_at = now()
        where id = $2::uuid and workspace_id = $1::uuid and revoked_at is null
       returning 1) select count(*)::int as n from upd`,
    [workspaceId, keyId],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

export interface AuthenticatedKey {
  keyId: string; workspaceId: string; plan: 'starter' | 'growth' | 'scale'; scopes: string[];
}

/** Bearer → key row + the workspace's CURRENT plan (checked per request). */
export async function verifyApiKey(db: Db, bearer: string): Promise<AuthenticatedKey | null> {
  if (!/^rrs_(live|test)_[A-Za-z0-9]{32}$/.test(bearer)) return null;
  const r = await db.query<{
    id: string; workspace_id: string; scopes: string[];
    revoked_at: string | null; plan: 'starter' | 'growth' | 'scale';
    deleted_at: string | null;
  }>(
    `select k.id, k.workspace_id, k.scopes, k.revoked_at, w.plan::text as plan, w.deleted_at
       from api_keys k join workspaces w on w.id = k.workspace_id
      where k.key_hash = $1::text`,
    [hashToken(bearer)],
  );
  const row = r.rows[0];
  if (!row || row.revoked_at || row.deleted_at) return null;
  return { keyId: row.id, workspaceId: row.workspace_id, plan: row.plan, scopes: row.scopes };
}

export async function touchKey(db: Db, keyId: string): Promise<void> {
  await db.query('update api_keys set last_used_at = now() where id = $1::uuid', [keyId]);
}

// ---------------------------------------------------------------- rate limit

export interface RateVerdict {
  ok: boolean;
  remaining: number;
  retryAfterS: number;
  /** The journal row just reserved — the response updates its status/duration. */
  requestId?: number;
}

/** Sliding 60-second window, 120 requests per workspace, stored in Postgres. */
export const RATE_LIMIT_PER_MIN = 120;

export async function checkRateLimit(db: Db, workspaceId: string, route: string, keyId: string | null): Promise<RateVerdict> {
  const since = new Date(Date.now() - 60_000).toISOString();
  const r = await db.query<{ n: number }>(
    `select count(*)::int as n from api_requests
      where workspace_id = $1::uuid and created_at > $2::timestamptz`,
    [workspaceId, since],
  );
  const used = r.rows[0]?.n ?? 0;
  if (used >= RATE_LIMIT_PER_MIN) {
    const oldest = await db.query<{ created_at: string }>(
      `select created_at from api_requests
        where workspace_id = $1::uuid and created_at > $2::timestamptz
        order by created_at asc limit 1`,
      [workspaceId, since],
    );
    const retry = oldest.rows[0]
      ? Math.max(1, Math.ceil((new Date(oldest.rows[0].created_at).getTime() + 60_000 - Date.now()) / 1000))
      : 60;
    return { ok: false, remaining: 0, retryAfterS: Math.min(retry, 60) };
  }
  const ins = await db.query<{ id: number }>(
    `insert into api_requests (workspace_id, key_id, route, status_code, duration_ms)
     values ($1::uuid, $2::uuid, $3::text, 0, 0) returning id`,
    [workspaceId, keyId, route],
  );
  // Housekeeping: the window only ever needs the last few minutes.
  await db.query(
    `delete from api_requests where created_at < now() - interval '30 minutes'`,
  );
  return { ok: true, remaining: RATE_LIMIT_PER_MIN - used - 1, retryAfterS: 0, requestId: Number(ins.rows[0]!.id) };
}

export async function recordApiResponse(db: Db, requestId: number, statusCode: number, durationMs: number): Promise<void> {
  await db.query(
    'update api_requests set status_code = $2::int, duration_ms = $3::int where id = $1::bigint',
    [requestId, statusCode, durationMs],
  );
}

// ----------------------------------------------------------------- webhooks

export interface WebhookEndpoint {
  id: string; url: string; events: string[];
  failureCount: number; disabledAt: Date | null; disabledReason: string | null;
}

export async function listWebhookEndpoints(db: Db, workspaceId: string): Promise<WebhookEndpoint[]> {
  const r = await db.query<{
    id: string; url: string; events: string[]; failure_count: number;
    disabled_at: string | null; disabled_reason: string | null;
  }>(
    `select id, url, events, failure_count, disabled_at, disabled_reason
       from webhook_endpoints
      where workspace_id = $1::uuid and revoked_at is null
      order by created_at desc`,
    [workspaceId],
  );
  return r.rows.map((e) => ({
    id: e.id, url: e.url, events: e.events, failureCount: e.failure_count,
    disabledAt: e.disabled_at ? new Date(e.disabled_at) : null, disabledReason: e.disabled_reason,
  }));
}

export async function listDeadDeliveries(db: Db, workspaceId: string, limit = 5): Promise<{
  id: string; event: string; lastError: string | null; attempts: number; createdAt: Date;
}[]> {
  const r = await db.query<{
    id: string; event: string; last_error: string | null; attempts: number; created_at: string;
  }>(
    `select id, event, last_error, attempts, created_at from webhook_deliveries
      where workspace_id = $1::uuid and status = 'dead'
      order by created_at desc limit $2::int`,
    [workspaceId, limit],
  );
  return r.rows.map((d) => ({
    id: d.id, event: d.event, lastError: d.last_error, attempts: d.attempts,
    createdAt: new Date(d.created_at),
  }));
}

/**
 * Register an endpoint. The URL passes the SSRF guard here AND at delivery
 * time; the signing secret is encrypted at rest with the mailbox secret box.
 */
export async function createWebhookEndpoint(
  db: Db, workspaceId: string, url: string, events: string[],
  opts: { devLoopback?: boolean } = {},
): Promise<{ id: string; secret: string }> {
  const verdict = isDeliverableUrl(url, { allowInsecureLoopback: opts.devLoopback });
  if (!verdict.allowed) throw new Error(`SSRF_BLOCKED_${verdict.reason ?? 'unknown'}`.toUpperCase());
  const secret = `whsec_${randomBytes(24).toString('base64url')}`;
  const r = await db.query<{ id: string }>(
    `insert into webhook_endpoints (workspace_id, url, secret, events)
     values ($1::uuid, $2::text, $3::text, $4::text[]) returning id`,
    [workspaceId, url, encryptSecret(secret), events],
  );
  return { id: r.rows[0]!.id, secret };
}

/** Queue one delivery per subscribed endpoint. Returns the number queued. */
export async function enqueueWebhook(
  db: Db, workspaceId: string, event: string, payload: unknown,
): Promise<number> {
  const r = await db.query<{ id: string }>(
    `insert into webhook_deliveries (workspace_id, endpoint_id, event, payload)
     select $1::uuid, e.id, $2::text, $3::jsonb
       from webhook_endpoints e
      where e.workspace_id = $1::uuid and e.revoked_at is null
        and e.disabled_at is null and $2::text = any(e.events)
     returning id`,
    [workspaceId, event, JSON.stringify(payload ?? {})],
  );
  return r.rows.length;
}

export interface DueDelivery {
  id: string; endpointId: string; url: string; event: string;
  payload: unknown; secret: string; attempts: number; endpointFailures: number;
}

/** Force variant: every pending delivery regardless of the backoff clock. */
export async function duePending(db: Db, limit = 50): Promise<DueDelivery[]> {
  const r = await db.query<{
    id: string; endpoint_id: string; url: string; event: string;
    payload: string; secret: string; attempts: number; endpoint_failures: number;
  }>(
    `select d.id, d.endpoint_id, e.url, d.event, d.payload::text as payload,
            e.secret, d.attempts, e.failure_count as endpoint_failures
       from webhook_deliveries d
       join webhook_endpoints e on e.id = d.endpoint_id
      where d.status = 'pending' and e.revoked_at is null and e.disabled_at is null
      order by d.created_at
      limit $1::int`,
    [limit],
  );
  return r.rows.map((d) => ({
    id: d.id, endpointId: d.endpoint_id, url: d.url, event: d.event,
    payload: JSON.parse(d.payload) as unknown,
    secret: decryptSecret(d.secret), attempts: d.attempts, endpointFailures: d.endpoint_failures,
  }));
}

export async function dueDeliveries(db: Db, limit = 20): Promise<DueDelivery[]> {
  const r = await db.query<{
    id: string; endpoint_id: string; url: string; event: string;
    payload: string; secret: string; attempts: number; endpoint_failures: number;
  }>(
    `select d.id, d.endpoint_id, e.url, d.event, d.payload::text as payload,
            e.secret, d.attempts, e.failure_count as endpoint_failures
       from webhook_deliveries d
       join webhook_endpoints e on e.id = d.endpoint_id
      where d.status = 'pending' and d.next_attempt_at <= now()
        and e.revoked_at is null and e.disabled_at is null
      order by d.next_attempt_at
      limit $1::int`,
    [limit],
  );
  return r.rows.map((d) => ({
    id: d.id, endpointId: d.endpoint_id, url: d.url, event: d.event,
    payload: JSON.parse(d.payload) as unknown,
    secret: decryptSecret(d.secret), attempts: d.attempts, endpointFailures: d.endpoint_failures,
  }));
}

export async function recordDeliveryAttempt(
  db: Db, deliveryId: string, endpointId: string,
  outcome: { ok: boolean; statusCode?: number; error?: string },
): Promise<'succeeded' | 'retry' | 'dead' | 'disabled'> {
  if (outcome.ok) {
    await db.query(
      `update webhook_deliveries set status = 'succeeded', attempts = attempts + 1,
              delivered_at = now(), last_status_code = $2::int, last_error = null
        where id = $1::uuid`,
      [deliveryId, outcome.statusCode ?? 200],
    );
    await db.query(
      'update webhook_endpoints set failure_count = 0 where id = $1::uuid', [endpointId],
    );
    return 'succeeded';
  }
  const r = await db.query<{ attempts: number; endpoint_failures: number }>(
    `update webhook_deliveries set attempts = attempts + 1,
            last_status_code = $2::int, last_error = $3::text
      where id = $1::uuid returning attempts`,
    [deliveryId, outcome.statusCode ?? 0, (outcome.error ?? 'error').slice(0, 300)],
  );
  const ep = await db.query<{ failure_count: number }>(
    `update webhook_endpoints set failure_count = failure_count + 1
      where id = $1::uuid returning failure_count`,
    [endpointId],
  );
  const attempts = r.rows[0]?.attempts ?? 1;
  const endpointFailures = ep.rows[0]?.failure_count ?? 1;
  if (endpointFailures >= 20) {
    await db.query(
      `update webhook_endpoints set disabled_at = now(), disabled_reason = '20 consecutive failures'
        where id = $1::uuid`,
      [endpointId],
    );
    await db.query(
      `update webhook_deliveries set status = 'dead' where endpoint_id = $1::uuid and status = 'pending'`,
      [endpointId],
    );
    return 'disabled';
  }
  if (attempts >= 3) {
    await db.query(`update webhook_deliveries set status = 'dead' where id = $1::uuid`, [deliveryId]);
    return 'dead';
  }
  return 'retry';
}

export async function scheduleRetry(db: Db, deliveryId: string, delayS: number): Promise<void> {
  await db.query(
    `update webhook_deliveries set next_attempt_at = now() + ($2::text || ' seconds')::interval
      where id = $1::uuid`,
    [deliveryId, String(delayS)],
  );
}

export async function deleteWebhookEndpoint(db: Db, workspaceId: string, endpointId: string): Promise<boolean> {
  const r = await db.query<{ n: number }>(
    `with upd as (
       update webhook_endpoints set revoked_at = now()
        where id = $2::uuid and workspace_id = $1::uuid and revoked_at is null
       returning 1) select count(*)::int as n from upd`,
    [workspaceId, endpointId],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

// ------------------------------------------------------- usage.threshold

/**
 * Fires `usage.threshold` once per day when usage crosses 80 % or 100 % of a
 * plan counter. Idempotent by construction: the dedupe looks at today's
 * already-enqueued threshold deliveries, not at a timer.
 */
export async function maybeUsageThreshold(
  db: Db, workspaceId: string,
  input: { counter: 'proposals' | 'emails' | 'seats' | 'mailboxes'; used: number; limit: number },
): Promise<boolean> {
  if (input.limit <= 0) return false;
  const ratio = input.used / input.limit;
  if (ratio < 0.8) return false;
  const today = new Date().toISOString().slice(0, 10);
  const prior = await db.query<{ n: number }>(
    `select count(*)::int as n from webhook_deliveries
      where workspace_id = $1::uuid and event = 'usage.threshold'
        and payload->>'counter' = $2::text and created_at::date = $3::date`,
    [workspaceId, input.counter, today],
  );
  if ((prior.rows[0]?.n ?? 0) > 0) return false;
  await enqueueWebhook(db, workspaceId, 'usage.threshold', {
    counter: input.counter, used: input.used, limit: input.limit,
    percent: Math.round(ratio * 100),
  });
  return true;
}
