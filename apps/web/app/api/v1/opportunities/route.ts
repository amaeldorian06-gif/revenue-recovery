import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { withApiKey } from '../../../../lib/api-v1';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/opportunities — filters status/arm/since, limit ≤ 100, cursor
 * pagination (the cursor is opaque: base64 of created_at|id). Only rows of
 * the key's workspace — cross-tenant reads are the IDOR test, not a bug class
 * we fix after release.
 */
export const GET = withApiKey('read:opportunities', '/v1/opportunities', async ({ key, req }) => {
    const url = new URL(req.url);
    const status = url.searchParams.get('status');
    const arm = url.searchParams.get('arm');
    const since = url.searchParams.get('since');
    const limitRaw = Number(url.searchParams.get('limit') ?? 50);
    const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 50));
    const cursor = url.searchParams.get('cursor');

    let where = 'o.workspace_id = $1::uuid';
    const args: unknown[] = [key.workspaceId];
    if (status && ['open', 'won', 'lost'].includes(status)) {
      args.push(status);
      where += ` and o.status = $${args.length}::text`;
    }
    if (arm && ['treatment', 'holdout'].includes(arm)) {
      args.push(arm);
      where += ` and o.arm = $${args.length}::text`;
    }
    if (since) {
      const d = new Date(since);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json(
          { type: 'https://revenue-recovery-os.dev/problems/validation', title: 'since must be an ISO date', status: 400, code: 'VALIDATION' },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      args.push(d.toISOString());
      where += ` and o.updated_at > $${args.length}::timestamptz`;
    }
    if (cursor) {
      try {
        const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
        if (!iso || !id) throw new Error('bad');
        args.push(new Date(iso).toISOString(), id);
        where += ` and (o.updated_at, o.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`;
      } catch {
        return NextResponse.json(
          { type: 'https://revenue-recovery-os.dev/problems/validation', title: 'cursor is invalid', status: 400, code: 'VALIDATION' },
          { status: 400, headers: { 'content-type': 'application/problem+json' } },
        );
      }
    }

    const db = await getDb();
    const rows = await db.query<{
      id: string; client_name: string; title: string; amount_cents: number;
      status: string; arm: string; stage: string; created_at: string; updated_at: string;
      reply_received_at: string | null;
    }>(
      `select o.id, o.client_name, o.title, o.amount_cents, o.status::text as status,
              o.arm::text as arm, o.stage::text as stage, o.created_at::text, o.updated_at::text,
              o.reply_received_at::text
         from opportunities o
        where ${where}
        order by o.updated_at desc, o.id desc
        limit $${args.length + 1}::int`,
      [...args, limit + 1],
    );
    const hasMore = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]!;
      nextCursor = Buffer.from(`${last.updated_at}|${last.id}`, 'utf8').toString('base64url');
    }
    return NextResponse.json({
      data: page.map((o) => ({
        id: o.id, clientName: o.client_name, title: o.title,
        amountCents: o.amount_cents, status: o.status, arm: o.arm, stage: o.stage,
        replyReceivedAt: o.reply_received_at, createdAt: o.created_at, updatedAt: o.updated_at,
      })),
      nextCursor,
    });
  });
