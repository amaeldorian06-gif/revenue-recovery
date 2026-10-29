import { NextResponse } from 'next/server';
import { getSession } from '../../../../lib/session';
import { withTenant } from '../../../../lib/db';
import { lastWeeks } from '@rros/db/measurement';

export const dynamic = 'force-dynamic';

const HEADERS = [
  'week_start',
  'arm',
  'n_opportunities',
  'n_replies',
  'n_won',
  'revenue_cents',
  'n_expired',
];

/** The weekly log, as the customer would paste it into their accountant's file. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const weeks = await withTenant(session.workspaceId, (db) => lastWeeks(db, session.workspaceId));
  const lines = [HEADERS.join(',')];
  for (const w of weeks) {
    for (const arm of ['treatment', 'holdout'] as const) {
      const s = w[arm];
      lines.push(
        [w.weekStart, arm, s.nOpportunities, s.nReplies, s.nWon, s.revenueCents, s.nExpired].join(','),
      );
    }
  }

  return new NextResponse(lines.join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="mesure-${weeks.at(-1)?.weekStart ?? 'semaine'}.csv"`,
    },
  });
}
