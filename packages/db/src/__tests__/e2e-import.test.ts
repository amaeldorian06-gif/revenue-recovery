/**
 * End-to-end import against the real HTTP server, using the same modules the
 * route handlers use. Verifies the four-step wizard's data path and the figures
 * the calibration screen displays.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDb, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { parseCsvBuffer } from '../../../domain/src/import/parse.ts';
import { detectMapping } from '../../../domain/src/import/detect.ts';
import { importPipeline } from '../../../domain/src/import/pipeline.ts';
import { commitImport, loadExisting, portfolioSummary, assignArm } from '../repo/imports.ts';
import { classify } from '../../../domain/src/classify/state.ts';

let db: Db; let ws: string; let uid: string;

beforeAll(async () => {
  db = await createDb({ fresh: true });
  const c = await createWorkspaceWithOwner(db, { email: 'e2e@studio.fr', workspaceName: 'Studio Merlot', locale: 'fr' });
  ws = c.workspaceId; uid = c.userId;
});

describe('real file → database → calibration figures', () => {
  it('imports the 60-row French fixture and reports coherent numbers', async () => {
    const buf = readFileSync(new URL('../../../../data/exemple_pipeline.csv', import.meta.url));
    const parsed = parseCsvBuffer(buf);
    expect(parsed.rows).toHaveLength(60);

    const mapping = detectMapping(parsed.headers);
    const existing = await loadExisting(db, ws);
    const result = importPipeline(parsed.rows, {
      mapping, existing, now: new Date('2026-10-25'), holdoutRate: 0.2,
      assignArm: () => assignArm(0.2),
    });
    const outcome = await commitImport(db, result, {
      workspaceId: ws, userId: uid, filename: 'exemple_pipeline.csv',
      holdoutRate: 0.2, mapping, maxRows: 1000,
    });

    console.log(`    lues=${result.stats.rows} créées=${outcome.created} refusées=${outcome.skipped} holdout=${outcome.holdoutCreated}`);
    const reasons = result.skipped.reduce<Record<string, number>>((a, s) => { a[s.reason] = (a[s.reason] ?? 0) + 1; return a; }, {});
    console.log('    refus:', JSON.stringify(reasons));

    expect(outcome.created).toBeGreaterThan(50);
    expect(outcome.skipped).toBeGreaterThan(0);          // the deliberately dirty rows
    expect(outcome.holdoutCreated).toBeGreaterThan(5);   // ~20 %

    const s = await portfolioSummary(db, ws);
    console.log(`    portefeuille: total=${s.total} sans_réponse=${s.unanswered} exposé=${Math.round(s.exposedCents/100)}€ témoin=${s.holdout}`);
    expect(s.total).toBe(outcome.created);
    expect(s.exposedCents).toBeGreaterThan(0);
    expect(Math.abs(s.holdout - s.total * 0.2)).toBeLessThan(s.total * 0.15);
  });

  it('classifies the imported portfolio into the four states', async () => {
    const rows = await db.query<{
      amount_cents: string; stage: string; sent_at: string; last_touch_at: string | null;
      touch_count: number; reply_received_at: string | null; status: string;
    }>('select amount_cents, stage, sent_at, last_touch_at, touch_count, reply_received_at, status from opportunities');

    const counts: Record<string, number> = {};
    for (const r of rows.rows) {
      const c = classify({
        amountCents: Number(r.amount_cents), stage: r.stage, sentAt: r.sent_at,
        lastTouchAt: r.last_touch_at, touchCount: r.touch_count,
        replyReceivedAt: r.reply_received_at, status: r.status, now: new Date('2026-10-25'),
      });
      counts[c.state] = (counts[c.state] ?? 0) + 1;
    }
    console.log('    états:', JSON.stringify(counts));
    expect(Object.keys(counts).length).toBeGreaterThanOrEqual(2);
    expect(counts.no_reply ?? 0).toBeGreaterThan(0);
  });
});
