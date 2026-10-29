import { NextResponse } from 'next/server';
import { getDb } from './db';
import {
  verifyApiKey, checkRateLimit, recordApiResponse, touchKey, RATE_LIMIT_PER_MIN, type AuthenticatedKey,
} from '@rros/db/team';
import { scopeAllowed, type Scope } from '@rros/domain/authz/scopes';
import { getCurrentEntitlement } from '@rros/db/licensing';

/**
 * The v1 request pipeline: authenticate the key, check the plan at request
 * time, slide the rate window, replay idempotent POSTs. Errors are RFC 9457
 * problem documents with a stable `code` — a client that can parse one can
 * parse all.
 */
export function problem(status: number, code: string, title: string, detail?: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json(
    {
      type: `https://revenue-recovery-os.dev/problems/${code.toLowerCase()}`,
      title,
      status,
      code,
      ...(detail ? { detail } : {}),
      ...extra,
    },
    {
      status,
      headers: { 'content-type': 'application/problem+json' },
    },
  );
}

export interface V1Context {
  key: AuthenticatedKey;
  req: Request;
  requestId: number;
  startedAt: number;
}

type Handler = (ctx: V1Context) => Promise<NextResponse>;

/**
 * Wrap a v1 handler. Order matters: auth → plan+scope → rate limit →
 * handler; the response always carries X-RateLimit-Remaining, 429 always
 * carries Retry-After.
 */
export function withApiKey(requiredScope: Scope, route: string, fn: Handler) {
  return async (req: Request): Promise<Response> => {
    const startedAt = Date.now();
    const db = await getDb();
    const header = req.headers.get('authorization') ?? '';
    const bearer = header.replace(/^Bearer\s+/i, '').trim();
    if (!bearer) {
      return problem(401, 'UNAUTHENTICATED', 'Missing API key', 'Send `Authorization: Bearer rrs_live_…`.');
    }
    const key = await verifyApiKey(db, bearer);
    if (!key) {
      return problem(401, 'INVALID_KEY', 'Unknown or revoked API key');
    }
    const scope = scopeAllowed(key.plan, key.scopes, requiredScope);
    if (!scope.allowed) {
      if (scope.reasonCode === 'PLAN_FEATURE_UNAVAILABLE') {
        return problem(403, 'PLAN_FEATURE_UNAVAILABLE',
          'Your plan does not include this API capability',
          requiredScope === 'write:actions'
            ? 'Writing via the API requires the Scale plan. The API can prepare drafts, never send — that is true on every plan.'
            : 'The public API requires the Growth plan or above.');
      }
      return problem(403, 'SCOPE_MISSING', `The key lacks the ${requiredScope} scope`);
    }

    // Licensing gate (0009): a valid key on an expired/suspended subscription
    // stops here. The plan gate above is about WHAT the key may do; this one
    // is about whether the workspace is entitled at all this month.
    const license = await getCurrentEntitlement(db, key.workspaceId, new Date());
    if (!license.accessAllowed) {
      return problem(403, 'SUBSCRIPTION_REQUIRED',
        'The workspace subscription is not active',
        `Reason: ${license.reasonCode}. Renew from the subscription page.`);
    }

    const verdict = await checkRateLimit(db, key.workspaceId, route, key.keyId);
    if (!verdict.ok) {
      const res = problem(429, 'RATE_LIMITED', 'Too many requests',
        `Limit is ${RATE_LIMIT_PER_MIN} requests per minute per workspace.`,
        { retry_after: verdict.retryAfterS });
      res.headers.set('retry-after', String(verdict.retryAfterS));
      return res;
    }

    void touchKey(db, key.keyId).catch(() => undefined);

    try {
      const res = await fn({ key, req, requestId: verdict.requestId ?? 0, startedAt });
      res.headers.set('x-ratelimit-remaining', String(verdict.remaining));
      void recordApiResponse(db, verdict.requestId ?? 0, res.status, Date.now() - startedAt).catch(() => undefined);
      return res;
    } catch {
      const res = problem(500, 'INTERNAL', 'Unexpected error');
      res.headers.set('x-ratelimit-remaining', String(verdict.remaining));
      void recordApiResponse(db, verdict.requestId ?? 0, 500, Date.now() - startedAt).catch(() => undefined);
      return res;
    }
  };
}

/**
 * Idempotency for mutating endpoints: the first call stores its response,
 * a replayed `Idempotency-Key` returns the stored response unchanged.
 */
export async function replayOrStore(
  req: Request, workspaceId: string, route: string,
  run: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const db = await getDb();
  const idemKey = req.headers.get('idempotency-key')?.trim();
  if (!idemKey) return run();
  const prior = await db.query<{ status_code: number; response_body: unknown }>(
    `select status_code, response_body from api_idempotency
      where workspace_id = $1::uuid and route = $2::text and idem_key = $3::text`,
    [workspaceId, route, idemKey],
  );
  if (prior.rows[0]) {
    return NextResponse.json(prior.rows[0].response_body as object, { status: prior.rows[0].status_code });
  }
  const res = await run();
  // Store only completed creations, never the 429/5xx a client should retry.
  if (res.status < 400) {
    const bodyCopy = await res.clone().json().catch(() => ({}));
    await db.query(
      `insert into api_idempotency (workspace_id, route, idem_key, status_code, response_body)
       values ($1::uuid, $2::text, $3::text, $4::int, $5::jsonb)
       on conflict (workspace_id, route, idem_key) do nothing`,
      [workspaceId, route, idemKey, res.status, bodyCopy],
    );
  }
  return res;
}
