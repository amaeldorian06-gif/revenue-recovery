import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { resolveExportToken } from '../../../../../lib/gdpr';

export const dynamic = 'force-dynamic';

/** Download endpoint: token in the URL (the emailed link), expires in 24 h. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const resolved = await resolveExportToken(token);
  if (!resolved) return NextResponse.json({ error: 'expired' }, { status: 404 });
  const path = join(process.cwd(), 'var', 'exports', resolved.fileName);
  try {
    const zip = await readFile(path);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${resolved.fileName}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'gone' }, { status: 404 });
  }
}
