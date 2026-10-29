import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { withApiKey } from '../../../../lib/api-v1';
import { getUsage } from '@rros/db/billing';

export const dynamic = 'force-dynamic';

/** GET /v1/usage — the counters of the current billing period. */
export const GET = withApiKey('read:results', '/v1/usage', async ({ key }) => {
  const db = await getDb();
  const usage = await getUsage(db, key.workspaceId);
  return NextResponse.json({ data: usage });
});
