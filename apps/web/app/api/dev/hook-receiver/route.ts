import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

declare global {
  // eslint-disable-next-line no-var
  var __rrosHookLog: { id: string | null; event: string | null; signatures: string[]; body: string; at: string }[] | undefined;
}

/**
 * DEV ONLY — the local webhook receiver for the test-event flow. Records the
 * last deliveries (id + signature headers) so tools and tests can assert the
 * payload arrived signed. `?fail=500` answers 500 on purpose (retry / dead
 * letter tests). Disabled outside dev.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const fail = new URL(req.url).searchParams.get('fail');
  if (fail) return NextResponse.json({ error: 'failing_on_purpose' }, { status: Number(fail) });
  const body = await req.text();
  let parsed: unknown = {};
  try { parsed = JSON.parse(body); } catch { /* keep {} */ }
  globalThis.__rrosHookLog = globalThis.__rrosHookLog ?? [];
  globalThis.__rrosHookLog.unshift({
    id: (req.headers.get('x-rrs-id')),
    event: (req.headers.get('x-rrs-event')) ?? String((parsed as { event?: string }).event ?? ''),
    signatures: [req.headers.get('x-rrs-signature') ?? ''],
    body,
    at: new Date().toISOString(),
  });
  globalThis.__rrosHookLog = globalThis.__rrosHookLog.slice(0, 20);
  return NextResponse.json({ received: true });
}

export async function GET() {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ log: globalThis.__rrosHookLog ?? [] });
}
