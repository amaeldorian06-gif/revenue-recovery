/**
 * Criterion 9 — `/results` must open in under 800 ms p95 on a 5 000-dossier
 * workspace.
 *
 * The only way to meet that is to never bootstrap on a GET: the estimate is
 * computed by the weekly job and read back as one row. This test measures the
 * read path the browser actually uses, after the job has run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { isoWeekStart, runWeek, readResults, addDays } from '../repo/measurement.ts';

const NOW = new Date('2026-10-26T03:00:00Z');
const WEEK = isoWeekStart(NOW);
const N = 5000;

let db: Db;
let workspaceId: string;

beforeAll(async () => {
  db = await createDb({ fresh: true });
  const created = await createWorkspaceWithOwner(db, {
    email: 'perf@studio-merlot.fr', workspaceName: 'Studio Perf', locale: 'fr',
  });
  workspaceId = created.workspaceId;
  await db.query(`update experiments set started_at = '2026-06-01T00:00:00Z' where workspace_id = $1::uuid`, [
    workspaceId,
  ]);

  // 5 000 dossiers spread over the last 12 weeks, deterministic, 20 % holdout.
  await db.query(
    `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm)
     select $1::uuid,
            'perf-' || g,
            'Client ' || g,
            (50000 + (g * 7919) % 4000000)::bigint,
            $2::timestamptz + ((g % 84) || ' days')::interval,
            case when g % 7 = 0 then 'won' when g % 11 = 0 then 'expired' else 'open' end,
            case when g % 5 = 0 then 'holdout' else 'treatment' end
       from generate_series(1, ${N}) as g`,
    [workspaceId, `${addDays(WEEK, -7 * 11)}T09:00:00Z`],
  );

  // Twelve weekly buckets, then the attribution — exactly what the Monday job does.
  for (let w = 11; w >= 0; w -= 1) {
    const weekStart = addDays(WEEK, -7 * w);
    await runWeek(db, { workspaceId, weekStart });
  }
}, 180_000);

describe('results read path', () => {
  it('serves the screen in under 800 ms p95 without bootstrapping', async () => {
    const durations: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const t0 = performance.now();
      const payload = await readResults(db, { workspaceId, locale: 'fr', now: NOW });
      durations.push(performance.now() - t0);
      expect(payload).not.toBeNull();
      expect(payload!.weeks).toHaveLength(12);
    }

    durations.sort((a, b) => a - b);
    const p50 = durations[Math.floor(durations.length * 0.5)]!;
    const p95 = durations[Math.floor(durations.length * 0.95)]!;

    console.log(`    /results · p50=${p50.toFixed(0)} ms · p95=${p95.toFixed(0)} ms · max=${durations.at(-1)!.toFixed(0)} ms`);
    expect(p95).toBeLessThan(800);
  }, 120_000);

  it('keeps the payload coherent on a large workspace', async () => {
    const payload = await readResults(db, { workspaceId, locale: 'fr', now: NOW });
    const total = payload!.weeks.reduce((s, w) => s + w.treatment.nOpportunities + w.holdout.nOpportunities, 0);
    expect(total).toBe(N);
    expect(payload!.attribution.nTreatment).toBeGreaterThan(3000);
    expect(payload!.attribution.nHoldout).toBeGreaterThan(800);
    expect(payload!.series).toHaveLength(12);
    // Cumulative series, so the last point is the total revenue of the window.
    const last = payload!.series.at(-1)!;
    expect(last.treatmentCents).toBe(
      payload!.weeks.reduce((s, w) => s + w.treatment.revenueCents, 0),
    );
  }, 60_000);
});
