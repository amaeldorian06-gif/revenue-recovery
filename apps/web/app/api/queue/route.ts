import { NextResponse } from 'next/server';
import { getSession } from '../../../lib/session';
import { getTodayQueue } from '../../../lib/queue';

export const dynamic = 'force-dynamic';

/**
 * GET /api/queue?date=YYYY-MM-DD
 * The day's queue, served from the recommendations table (the cache).
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const url = new URL(req.url);
  const raw = url.searchParams.get('date');
  let date = new Date();
  if (raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return NextResponse.json({ error: 'invalid_date' }, { status: 400 });
    }
    date = new Date(`${raw}T09:00:00Z`);
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ error: 'invalid_date' }, { status: 400 });
    }
  }

  const started = performance.now();
  const queue = await getTodayQueue(session, date);
  const ms = Math.round(performance.now() - started);

  return NextResponse.json(
    { ...queue, durationMs: ms },
    { headers: { 'cache-control': 'no-store' } },
  );
}
