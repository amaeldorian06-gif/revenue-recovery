import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { withApiKey } from '../../../../lib/api-v1';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/recommendations?date=YYYY-MM-DD (default today) — the day's queue
 * as the engine ranked it, of this workspace only.
 */
export const GET = withApiKey('read:opportunities', '/v1/recommendations', async ({ key, req }) => {
    const url = new URL(req.url);
    const dateRaw = url.searchParams.get('date');
    let day: string;
    if (!dateRaw) {
      day = new Date().toISOString().slice(0, 10);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      day = dateRaw;
    } else {
      return NextResponse.json(
        { type: 'https://revenue-recovery-os.dev/problems/validation', title: 'date must be YYYY-MM-DD', status: 400, code: 'VALIDATION' },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );
    }

    const db = await getDb();
    const rows = await db.query<{
      id: string; opportunity_id: string; rank: number; priority: number;
      expected_value_cents: number | null; p_response: number | null; reason: string;
      acted: boolean;
    }>(
      `select r.id, r.opportunity_id, r.rank, r.priority, r.expected_value_cents,
              r.p_response, r.reason, r.acted
         from recommendations r
        where r.workspace_id = $1::uuid and r.generated_for = $2::date
        order by r.rank asc limit 100`,
      [key.workspaceId, day],
    );
    return NextResponse.json({
      date: day,
      data: rows.rows.map((r) => ({
        id: r.id, opportunityId: r.opportunity_id, rank: r.rank,
        priority: r.priority, expectedValueCents: r.expected_value_cents,
        pResponse: r.p_response, why: r.reason, acted: r.acted,
      })),
    });
  });
