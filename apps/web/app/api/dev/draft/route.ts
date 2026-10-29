import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withSession } from '../../../../lib/api';
import { generateFor } from '../../../../lib/drafting';
import { withTenant } from '../../../../lib/db';
import type { LlmProvider, LlmRequest } from '@rros/domain/drafting/generate';

export const dynamic = 'force-dynamic';

/**
 * DEV ONLY — proves criterion 3 end to end.
 *
 * The real writer always passes its guardrails, so the "twice refused" path cannot
 * be produced through the normal endpoint. This route injects a writer that
 * breaks the rules on purpose, and returns the same JSON shape as
 * `/api/drafts/generate`, so what is measured is the production branch.
 */
class ViolatingWriter implements LlmProvider {
  readonly name = 'violating-writer';
  calls = 0;

  async complete(_req: LlmRequest) {
    this.calls += 1;
    const body =
      this.calls === 1
        ? 'Bonjour, je me permets de revenir vers vous : nous vous accordons une remise de 15 % si vous signez avant vendredi, dernière relance urgente ! Que décidez-vous ? Et quand ?'
        : 'Bonjour, remise de 10 % garantie pour une signature avant lundi. Dernière relance avant clôture, réponse urgente attendue, paiement à réception ! Que fait-on ?';
    return {
      model: 'violating-writer',
      text: JSON.stringify({ subject: 'Dernière relance', body }),
    };
  }
}

const Body = z.object({ opportunityId: z.string().uuid() });

export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return withSession(async (session) => {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

    const writer = new ViolatingWriter();
    const draft = await generateFor(session, parsed.data.opportunityId, 'warm', writer);

    const persisted = await withTenant(session.workspaceId, (db) =>
      db.query<{ n: string; codes: string[]; rationale: string | null }>(
        `select count(*)::text as n, min(violation_codes::text)::text[] as codes, max(rationale) as rationale
           from actions
          where opportunity_id = $1::uuid and kind = 'draft_generated' and status = 'failed'`,
        [parsed.data.opportunityId],
      ),
    );

    return NextResponse.json({
      draft: draft.status === 'draft' && !draft.manual ? { body: draft.body } : null,
      reason: draft.reason,
      violations: draft.violations,
      providerCalls: draft.providerCalls,
      writerCalls: writer.calls,
      persistedFailures: Number(persisted.rows[0]?.n ?? 0),
      persistedCodes: persisted.rows[0]?.codes ?? [],
      manualFallback: draft.manual,
    });
  });
}
