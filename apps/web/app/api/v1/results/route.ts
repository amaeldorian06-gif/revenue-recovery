import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { withApiKey } from '../../../../lib/api-v1';
import { readResults } from '@rros/db/measurement';

export const dynamic = 'force-dynamic';

/**
 * GET /v1/results — level A/B/C with intervals and `significant`, straight
 * from the measurement engine that feeds /results:
 *  • A — the attributed effect: estimate, 95 % CI, p-value, significant.
 *  • B — treated-arm revenue (win-rate tracked by the UI panel).
 *  • C — holdout revenue rescaled to the treatment size.
 * When the test is not significant, the API says so in the first field,
 * exactly like the UI does.
 */
export const GET = withApiKey('read:results', '/v1/results', async ({ key }) => {
  const db = await getDb();
  const payload = await readResults(db, { workspaceId: key.workspaceId, locale: 'fr' });
  if (!payload) {
    return NextResponse.json({
      significant: false, data: [],
      note: 'No measured result yet — the experiment needs answered sends.',
    });
  }
  const a = payload.attribution;
  const data = [
    {
      level: 'A',
      estimate: a.estimateCents,
      ciLow: a.ciLow,
      ciHigh: a.ciHigh,
      pValue: a.pValue,
      significant: a.significant,
      nTreatment: a.nTreatment,
      nHoldout: a.nHoldout,
    },
    {
      level: 'B',
      estimate: a.revenueBCents,
      ciLow: null,
      ciHigh: null,
      significant: null,
      note: 'traité — chiffre d’affaires des dossiers traités',
    },
    {
      level: 'C',
      estimate: a.revenueCCents,
      ciLow: null,
      ciHigh: null,
      significant: null,
      note: 'témoin — revenu des témoins, ramené à la taille du groupe traité',
    },
  ];
  return NextResponse.json({
    significant: a.significant,
    data,
    weekStart: a.weekStart,
    weeksMeasured: payload.weeksMeasured,
    headline: payload.headline.text,
  });
});
