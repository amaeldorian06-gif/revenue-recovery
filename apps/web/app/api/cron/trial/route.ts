import { NextResponse } from 'next/server';
import { asAdmin, getDb } from '../../../../lib/db';
import { runTrialJob } from '@rros/db/billing';
import { defaultEmailProvider } from '@rros/domain/sending/providers/index';

export const dynamic = 'force-dynamic';

/**
 * The trial job: day-3 and day-10 emails (what was detected, acted on, what
 * remains — never pressure copy) and the trial-expired event. Bearer
 * CRON_SECRET only.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const db = await getDb();
  const provider = defaultEmailProvider();

  const result = await asAdmin((conn) =>
    runTrialJob(conn, async (workspaceId, ownerEmail, kind) => {
      const what = kind === 'day3'
        ? 'Jour 3 : voici ce que le produit a détecté dans votre portefeuille.'
        : 'Jour 10 : voici ce qui a été traité et ce qui reste à traiter.';
      await provider.send({
        to: ownerEmail,
        subject: kind === 'day3' ? 'Vos 3 premiers jours' : 'Ce que le produit a déjà fait pour vous',
        body: `${what}\nOuvrez l’écran Aujourd’hui : la file est prête, avec les explications de chaque dossier.\nL’équipe`,
        idempotencyKey: `trial:${workspaceId}:${kind}`,
      });
    }),
  );
  return NextResponse.json({ ok: true, ...result });
}
