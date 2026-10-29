import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withSession } from '../../../../lib/api';
import { withTenant, asAdmin } from '../../../../lib/db';
import { isoWeekStart, addDays, writeWeek, writeAttribution, runningExperiment, lastWeeks } from '@rros/db/measurement';
import { mulberry32 } from '@rros/domain/measurement/random';

export const dynamic = 'force-dynamic';

const Body = z.object({
  weeks: z.number().int().min(1).max(12).default(12),
  perWeek: z.number().int().min(0).max(400).default(40),
  /** Share of dossiers sent to the holdout. */
  rate: z.number().min(0.1).max(0.3).default(0.2),
  /** True lift of the treatment arm, applied to the win probability. */
  lift: z.number().min(0).max(2).default(0.35),
  /** Creates a real coherence divergence: a won deal corrected after the week was frozen. */
  incoherent: z.boolean().default(false),
  seed: z.number().int().default(20261026),
});

/**
 * DEV ONLY — a twelve-week commercial history.
 *
 * The CSV import gives a portfolio dated "last Tuesday"; measurement needs twelve
 * weeks with won and lost outcomes in both arms. This route writes that history
 * and runs the same weekly job the cron runs, so the results screen is exercised
 * on the production code path.
 */
export async function POST(req: Request) {
  if (process.env.RROS_DEV_SEED !== '1') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return withSession(async (session) => {
    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    const { weeks, perWeek, rate, lift, incoherent, seed } = parsed.data;

    const experiment = await withTenant(session.workspaceId, (db) => runningExperiment(db, session.workspaceId));
    if (!experiment) return NextResponse.json({ error: 'no_experiment' }, { status: 409 });

    // The experiment must predate the history it measures. `experiments` is
    // read-only for the tenant role on purpose: nobody, in the product, gets to
    // move the start of the measurement.
    await asAdmin((db) =>
      db.query(`update experiments set started_at = $2::timestamptz where id = $1::uuid`, [
        experiment.id,
        `${addDays(isoWeekStart(new Date()), -7 * weeks)}T00:00:00Z`,
      ]),
    );

    const result = await withTenant(session.workspaceId, async (db) => {

      const rng = mulberry32(seed);
      const thisMonday = isoWeekStart(new Date());
      let written = 0;
      let madeWonId: string | null = null;

      for (let w = weeks - 1; w >= 0; w -= 1) {
        const weekStart = addDays(thisMonday, -7 * w);

        // One multi-row insert per week: 34 queries per row would make this route
        // the slowest thing in the dev loop, and it is only demo data.
        const values: unknown[] = [session.workspaceId];
        const tuples: string[] = [];
        for (let i = 0; i < perWeek; i += 1) {
          const holdout = rng() < rate;
          const pWin = holdout ? 0.12 : Math.min(0.95, 0.12 * (1 + lift));
          const status = rng() < pWin ? 'won' : rng() < 0.25 ? 'lost' : 'open';
          const amount = Math.round((8_000 + rng() * 60_000) * 100);
          const replied = rng() < 0.3;
          const id = crypto.randomUUID();
          const base = values.length;
          values.push(
            id,
            `dev-${seed}-${weekStart}-${i}`,
            `Client ${weekStart.slice(5)}-${i}`,
            amount,
            `${weekStart}T09:00:00Z`,
            status,
            holdout ? 'holdout' : 'treatment',
            status !== 'open' || replied,
          );
          tuples.push(
            `($${base + 1}::uuid, $1::uuid, $${base + 2}, $${base + 3}, $${base + 4}::bigint,
              $${base + 5}::timestamptz, $${base + 6}, $${base + 7}, 'proposal_sent',
              case when $${base + 6} <> 'open' or $${base + 8} then $${base + 5}::timestamptz + interval '4 days' end,
              case when $${base + 6} = 'won' then $${base + 5}::timestamptz + interval '9 days' end)`,
          );
          if (!holdout && status === 'won' && !madeWonId && w > 0) madeWonId = id;
          written += 1;
        }
        if (tuples.length > 0) {
          await db.query(
            `insert into opportunities
               (id, workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, stage,
                reply_received_at, closed_at)
             values ${tuples.join(',')}`,
            values,
          );
        }

        await writeWeek(db, { workspaceId: session.workspaceId, experimentId: experiment.id, weekStart });
        // 2 000 resamples for demo history; the production job uses the default
        // 10 000 — the estimate is identical, only the interval's smoothness moves.
        await writeAttribution(db, {
          workspaceId: session.workspaceId, experimentId: experiment.id, weekStart,
          resamples: 2000, seed,
        });
      }

      if (incoherent && madeWonId) {
        // The week is frozen; the deal is corrected afterwards. B no longer matches
        // the cohort, which is exactly what the coherence check exists to catch.
        // The correction is sized from the current estimate so the alarm fires
        // deterministically, whatever the generated numbers happen to be.
        const weekStart = addDays(thisMonday, -7);
        const current = await db.query<{ e: string }>(
          `select estimate_cents::text as e from attribution_results
            where experiment_id = $1::uuid and week_start = $2::date`,
          [experiment.id, weekStart],
        );
        const estimate = Math.abs(Number(current.rows[0]?.e ?? 0));
        const delta = 3 * estimate + 10_000_000;
        await db.query(`update opportunities set amount_cents = amount_cents + $2::bigint where id = $1::uuid`, [
          madeWonId, delta,
        ]);
        await writeAttribution(db, {
          workspaceId: session.workspaceId, experimentId: experiment.id, weekStart, resamples: 2000, seed,
        });
      }

      const weeksWritten = await lastWeeks(db, session.workspaceId);
      return { written, weeks: weeksWritten.length, incoherent };
    });

    return NextResponse.json({ ok: true, ...result });
  });
}
