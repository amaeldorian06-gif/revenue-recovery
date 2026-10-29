import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Liveness — deliberately touches NOTHING (no DB): if this answers, the
 * process is up. Deep checks live at /api/health/deep. */
export function GET() {
  return NextResponse.json({ status: 'ok' });
}
