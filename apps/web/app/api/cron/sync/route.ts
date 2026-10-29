import { NextResponse } from 'next/server';
import { asAdmin, getDb } from '../../../../lib/db';
import { jobStart, jobFinish } from '@rros/db/jobs';
import { syncMailbox, loadMailboxForSync, decryptSecret } from '@rros/db/inbox';
import { sandboxMail } from '@rros/domain/inbox/provider';
import { gmailProvider } from '@rros/domain/inbox/gmail';
import { imapProvider } from '@rros/domain/inbox/imap';

export const dynamic = 'force-dynamic';

/**
 * The sync job. Every 10 minutes in production, one mailbox per invocation
 * (round-robin), a 30-second deadline per mailbox: resumability beats
 * completeness. Bearer CRON_SECRET only.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const runId = await asAdmin((c) => jobStart(c, 'cron.sync'));

  const db = await getDb();
  // Optional ops override: sync one tenant's mailbox now instead of round-robin.
  const wanted = new URL(req.url).searchParams.get('workspaceId') ?? undefined;
  const out = await asAdmin(async (conn) => {
    const mailbox = await loadMailboxForSync(conn, wanted ? { workspaceId: wanted } : undefined);
    if (!mailbox) return { status: 'idle' as const };

    const storeBody = await asAdmin((c) =>
      c.query<{ store_body: boolean }>('select store_body from workspaces where id = $1::uuid', [mailbox.workspaceId]),
    );

    let provider;
    switch (mailbox.provider) {
      case 'gmail_oauth':
        provider = gmailProvider();
        break;
      case 'smtp_imap':
        provider = imapProvider();
        break;
      default:
        provider = sandboxMail();
    }

    const creds = mailbox.credentials ? decryptSecret(mailbox.credentials) : null;
    return syncMailbox(
      conn,
      { ...mailbox, credentials: creds },
      provider,
      { storeBody: storeBody.rows[0]?.store_body === true },
    );
  });
  await asAdmin((c) => jobFinish(c, runId, 'ok', 0));

  return NextResponse.json({ ok: out.status !== 'error', ...out });
}
