import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '../../../lib/db';
import { recordEvent, isEventName, looksLikeBot } from '../../../lib/analytics';

export const dynamic = 'force-dynamic';

/**
 * Funnel beacon (public, anonymous). No auth by design — but every field is
 * validated, the event name is an allowlist, crawlers are refused, and the
 * table holds no financial data by schema. This endpoint must stay cheap:
 * one insert, no read.
 */
const Body = z.object({
  name: z.string().refine(isEventName, 'unknown_event'),
  path: z.string().max(160).optional(),
  locale: z.enum(['fr', 'en']).optional(),
  props: z.record(z.string(), z.union([z.string().max(120), z.number(), z.boolean()])).optional(),
});

export async function POST(req: Request): Promise<Response> {
  if (looksLikeBot(req.headers.get('user-agent'))) {
    return new NextResponse(null, { status: 204 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_event' }, { status: 400 });
  }
  const db = await getDb();
  const anid = req.headers.get('cookie')?.match(/rros_anid=([^;]+)/)?.[1] ?? null;
  const ok = await recordEvent(db, {
    name: parsed.data.name,
    path: parsed.data.path,
    locale: parsed.data.locale,
    anonymousId: anid,
    props: parsed.data.props,
  });
  return new NextResponse(null, { status: ok ? 204 : 202 });
}
