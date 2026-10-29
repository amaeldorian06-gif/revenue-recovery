import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withEntitlement } from '../../../lib/licensing';
import { getDb } from '../../../lib/db';
import { arSnapshot, arToCsv, PAYMENT_TERM_DAYS } from '@rros/db/ar';

export const dynamic = 'force-dynamic';

/**
 * Accounts Receivable — server-side filters/sort/pagination over per-client
 * aggregates of the workspace's OWN data. Everything is validated here (the
 * client only ever speaks through query params), entitlement checked before
 * any data leaves the server, and the workspace comes from the session —
 * never from the request.
 */

const QuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['open', 'won', 'lost', 'all']).default('open'),
  age_min: z.coerce.number().int().min(0).max(3650).optional(),
  age_max: z.coerce.number().int().min(0).max(3650).optional(),
  priority: z.enum(['high', 'mid', 'low']).optional(),
  view: z.enum(['all', 'priority_high', 'overdue90', 'stale']).default('all'),
  sort: z.enum(['amount_desc', 'amount_asc', 'age_desc', 'priority_desc', 'name_asc']).default('amount_desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(5).max(100).default(25),
  format: z.enum(['json', 'csv']).default('json'),
});

export async function GET(req: Request) {
  return withEntitlement(async (session) => {
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid_query', detail: parsed.error.issues[0]?.message },
        { status: 400 },
      );
    }
    const q = parsed.data;
    const db = await getDb();
    const filters = {
      q: q.q || undefined,
      status: q.status,
      ageMin: q.age_min,
      ageMax: q.age_max,
      priority: q.priority,
      view: q.view,
      sort: q.sort,
      page: q.page,
      pageSize: q.page_size,
    };

    if (q.format === 'csv') {
      // Export honours the filters and exports the WHOLE filtered set
      // (pageSize 0 = no pagination), never just the current page.
      const full = await arSnapshot(db, session.workspaceId, new Date(), { ...filters, page: 1, pageSize: 0 });
      const csv = arToCsv(full.rows);
      return new NextResponse(`\uFEFF${csv}`, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="creances-${new Date().toISOString().slice(0, 10)}.csv"`,
          'x-ar-payment-term-days': String(PAYMENT_TERM_DAYS),
        },
      });
    }

    return NextResponse.json(await arSnapshot(db, session.workspaceId, new Date(), filters),
      { headers: { 'cache-control': 'no-store' } });
  });
}
