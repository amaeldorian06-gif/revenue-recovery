/**
 * Phase 08 — the CI benchmark. Seeds a reduced but representative dataset
 * (5 000 opportunities, 60 000 signals — the same shape as the load route),
 * then asserts the two queue paths stay within 2× the production threshold
 * (p95 < 400 ms → fail above 800 ms). This is the same guarantee PERF.md
 * documents, enforced on every commit instead of measured once.
 *
 * The generation path (first visitor of the morning) has its own, wider
 * budget: it is allowed 4 s on the CI machine, which is ~7× the measured
 * 578 ms of the production server, so a slow runner fails the build only
 * when something is genuinely wrong (a plan regression, a missing ANALYZE).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, truncateAll, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { generateQueue, readQueue, isoDate } from '../repo/queue.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const N_OPPS = 5_000;
const N_SIGNALS = 60_000;
/** 2× the production threshold (400 ms) — the criterion that gates CI. */
const READ_P95_BUDGET_MS = 800;
const GENERATE_BUDGET_MS = 4_000;

let db: Db;
let ws: string;

beforeAll(async () => {
  db = await createDb({ fresh: true });

  const created = await createWorkspaceWithOwner(db, {
    email: 'bench@agence-bellamy.fr', workspaceName: 'Bench CI', locale: 'fr',
  });
  ws = created.workspaceId;

  // Bulk seed — chunked inserts, same shape as /api/dev/load-seed.
  const touches = [0, 0, 0, 1, 1, 2, 2, 0, 1, 3];
  const stages = ['proposal_sent', 'followup_1', 'followup_2', 'negotiation'];
  const ids: string[] = [];
  for (let start = 0; start < N_OPPS; start += 250) {
    const rows: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < Math.min(start + 250, N_OPPS); i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      const base = params.length;
      rows.push(
        `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}::int, ` +
        `now() - ($${base + 5}::int || ' days')::interval, $${base + 6}, $${base + 7}::int, 'treatment', 'open')`,
      );
      params.push(id, ws, `Bench Client ${i}`, 500_000 + (i % 900) * 1000,
        i % 10 === 9 ? i % 2 : 14 + (i % 70), stages[i % stages.length], touches[i % touches.length]);
    }
    await db.query(
      `insert into opportunities (id, workspace_id, client_name, amount_cents, sent_at, stage, touch_count, arm, status)
       values ${rows.join(', ')}`,
      params,
    );
  }
  for (let start = 0; start < N_SIGNALS; start += 500) {
    const rows: string[] = [];
    const params: unknown[] = [];
    for (let i = start; i < Math.min(start + 500, N_SIGNALS); i++) {
      const base = params.length;
      rows.push(`($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, now() - ($${base + 4}::int || ' hours')::interval)`);
      params.push(ws, ids[i % ids.length], i % 2 === 0 ? 'email_open' : 'link_click', (i % 24) * 30);
    }
    await db.query(
      `insert into signal_events (workspace_id, opportunity_id, kind, occurred_at) values ${rows.join(', ')}`,
      params,
    );
  }
  // Without statistics the planner picks catastrophic nested loops (a plain
  // count went 7 s → 26 ms). Production refreshes stats after bulk imports;
  // the benchmark must measure the same conditions.
  await db.exec('analyze');
}, 120_000);

describe('CI benchmark — queue on the load dataset (5 000 opps / 60 000 signals)', () => {
  it(`generation (first call of the day) completes below ${GENERATE_BUDGET_MS} ms`, async () => {
    const t0 = performance.now();
    const res = await generateQueue(db, { workspaceId: ws, date: NOW });
    const ms = performance.now() - t0;
    expect(res.items.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(`[bench] generateQueue ${Math.round(ms)} ms · ${res.items.length} items`);
    expect(ms).toBeLessThan(GENERATE_BUDGET_MS);
  });

  it(`readQueue p95 stays below ${READ_P95_BUDGET_MS} ms over 50 calls (prod threshold 400 ms)`, async () => {
    const generatedFor = isoDate(NOW);
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      const items = await readQueue(db, ws, generatedFor);
      times.push(performance.now() - t0);
      expect(items.length).toBeGreaterThan(0);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95) - 1]!;
    // eslint-disable-next-line no-console
    console.log(`[bench] readQueue p50 ${Math.round(times[Math.floor(times.length / 2)]!)} ms · p95 ${Math.round(p95)} ms`);
    expect(p95).toBeLessThan(READ_P95_BUDGET_MS);
  });
});
