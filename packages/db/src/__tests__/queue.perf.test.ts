/**
 * Criterion 9: 5 000 opportunities, 50 generations, p95 < 400 ms.
 *
 * The threshold is deliberately hard-coded here and not configurable: a
 * performance gate that can be relaxed by an environment variable is not a gate.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { generateQueue } from '../repo/queue.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const N = 5_000;
const CALLS = 50;
const P95_BUDGET_MS = 400;

let db: Db;
let ws: string;

beforeAll(async () => {
  db = await createDb({ fresh: true });
  await truncateAll(db);
  const a = await createWorkspaceWithOwner(db, {
    email: `perf-${crypto.randomUUID()}@t.fr`, workspaceName: 'Perf', locale: 'fr',
  });
  ws = a.workspaceId;

  // One COPY-style bulk insert in chunks of 500, the same shape as a real import.
  const clients = Array.from({ length: 120 }, (_, i) => `Client ${i}`);
  const stages = ['proposal_sent', 'followup_1', 'followup_2', 'negotiation'];

  for (let start = 0; start < N; start += 500) {
    const values: string[] = [];
    const params: unknown[] = [ws];
    for (let i = start; i < Math.min(start + 500, N); i += 1) {
      const b = params.length;
      values.push(
        `($1::uuid, $${b + 1}, $${b + 2}, $${b + 3}::bigint, $${b + 4}, $${b + 5}::timestamptz, `
        + `$${b + 6}, $${b + 7}, $${b + 8}, 'treatment')`,
      );
      params.push(
        clients[i % clients.length]!,
        `Projet ${i}`,
        String((2_000 + (i % 90) * 500) * 100),
        stages[i % stages.length]!,
        new Date(NOW.getTime() - (1 + (i % 40)) * 86_400_000).toISOString(),
        i % 4, i % 5 === 0 ? 'won' : 'open', new Date(NOW.getTime() - (i % 7) * 86_400_000).toISOString(),
      );
    }
    await db.query(
      `insert into opportunities
         (workspace_id, client_name, title, amount_cents, stage, sent_at, touch_count, status, last_touch_at, arm)
       values ${values.join(',')}`,
      params,
    );
  }
  // The real import flow runs ANALYZE after bulk loads (repo/imports.ts does
  // exactly this) — without fresh statistics the real-Postgres planner flips
  // to catastrophic plans; PGlite masked it. The test simulates the
  // post-import state, so it includes the post-import refresh.
  await db.query('analyze opportunities');
}, 120_000);

describe('queue performance', () => {
  it(`${N} opportunities × ${CALLS} generations → p95 under ${P95_BUDGET_MS} ms`, async () => {
    // One warm-up call: JIT, plan cache, first-touch pages.
    await generateQueue(db, { workspaceId: ws, date: NOW, dryRun: true });

    const durations: number[] = [];
    for (let i = 0; i < CALLS; i += 1) {
      const t0 = performance.now();
      await generateQueue(db, { workspaceId: ws, date: NOW, dryRun: true });
      durations.push(performance.now() - t0);
    }

    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(0.95 * CALLS) - 1]!;
    const median = durations[Math.floor(CALLS / 2)]!;
    console.log(`    p50=${median.toFixed(0)} ms · p95=${p95.toFixed(0)} ms · max=${durations.at(-1)!.toFixed(0)} ms`);

    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 120_000);
});
