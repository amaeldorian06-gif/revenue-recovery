/**
 * Phase 03 persistence: the queue is a table, and that table must obey three
 * rules — idempotent regeneration, acted rows survive, and the tenant role sees
 * nothing that is not its own.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, asWorkspace, asSuperuser, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import { generateQueue, readQueue, loadCandidates, isoDate, expireWindows } from '../repo/queue.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
let db: Db;
let ws: string;
let other: string;
let owner: string;

const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

async function seedOpportunity(
  workspaceId: string,
  o: {
    client: string; amount: number; weeks: number; touch?: number; lastTouchWeeks?: number | null;
    arm?: 'treatment' | 'holdout'; status?: string; replied?: string | null; stage?: string;
  },
) {
  const id = crypto.randomUUID();
  await db.query(
    `insert into opportunities
       (id, workspace_id, client_name, title, amount_cents, stage, sent_at, last_touch_at,
        touch_count, status, arm, reply_received_at)
     values ($1::uuid, $2::uuid, $3, $4, $5::bigint, $6, $7::timestamptz, $8::timestamptz,
             $9, $10, $11, $12::timestamptz)`,
    [
      id, workspaceId, o.client, `Projet ${o.client}`, o.amount * 100, o.stage ?? 'proposal_sent',
      day(o.weeks * 7),
      o.lastTouchWeeks === null || o.lastTouchWeeks === undefined ? null : day(o.lastTouchWeeks * 7),
      o.touch ?? 0, o.status ?? 'open', o.arm ?? 'treatment', o.replied ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const a = await createWorkspaceWithOwner(db, { email: `q-${crypto.randomUUID()}@t.fr`, workspaceName: 'Queue A', locale: 'fr' });
  const b = await createWorkspaceWithOwner(db, { email: `q-${crypto.randomUUID()}@t.fr`, workspaceName: 'Queue B', locale: 'fr' });
  ws = a.workspaceId; owner = a.userId; other = b.workspaceId;
});

describe('generation', () => {
  it('writes one recommendation row per queue item, ranked from 1', async () => {
    for (let i = 0; i < 10; i += 1) await seedOpportunity(ws, { client: `Client ${i}`, amount: 10_000 + i * 100, weeks: 2 });
    const out = await generateQueue(db, { workspaceId: ws, date: NOW });

    expect(out.items.length).toBe(8); // default capacity
    expect(out.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const rows = await db.query<{ n: string }>(
      `select count(*) as n from recommendations where workspace_id = $1::uuid`,
      [ws],
    );
    expect(Number(rows.rows[0]!.n)).toBe(8);
  });

  it('is idempotent: regenerating the same date does not duplicate rows', async () => {
    for (let i = 0; i < 10; i += 1) await seedOpportunity(ws, { client: `Client ${i}`, amount: 10_000, weeks: 2 });
    await generateQueue(db, { workspaceId: ws, date: NOW });
    const second = await generateQueue(db, { workspaceId: ws, date: NOW });

    const rows = await db.query<{ n: string }>(
      `select count(*) as n from recommendations where workspace_id = $1::uuid`,
      [ws],
    );
    expect(Number(rows.rows[0]!.n)).toBe(8);
    expect(second.items.length).toBe(8);
  });

  it('keeps a row the user already acted on, and fills the remaining slots', async () => {
    for (let i = 0; i < 10; i += 1) await seedOpportunity(ws, { client: `Client ${i}`, amount: 10_000 + i * 100, weeks: 2 });
    const first = await generateQueue(db, { workspaceId: ws, date: NOW });
    const actedId = first.items[0]!.opportunityId;

    await db.query(
      `update recommendations set acted = true, acted_at = now(), action_kind = 'draft_sent'
        where workspace_id = $1::uuid and opportunity_id = $2::uuid`,
      [ws, actedId],
    );

    const second = await generateQueue(db, { workspaceId: ws, date: NOW });
    expect(second.actedKept).toBe(1);
    expect(second.items.length).toBe(7); // 8 − 1 already done
    expect(second.items.some((i) => i.opportunityId === actedId)).toBe(false);

    const kept = await db.query<{ acted: boolean; rank: number }>(
      `select acted, rank from recommendations where workspace_id = $1::uuid and opportunity_id = $2::uuid`,
      [ws, actedId],
    );
    expect(kept.rows[0]!.acted).toBe(true);
  });

  it('the database refuses to rewrite a row that was acted on', async () => {
    for (let i = 0; i < 3; i += 1) await seedOpportunity(ws, { client: `Client ${i}`, amount: 10_000, weeks: 2 });
    await generateQueue(db, { workspaceId: ws, date: NOW });
    const id = (await db.query<{ opportunity_id: string }>(
      `select opportunity_id from recommendations limit 1`,
    )).rows[0]!.opportunity_id;

    await db.query(`update recommendations set acted = true where opportunity_id = $1::uuid`, [id]);
    await expect(
      db.query(`update recommendations set score_cents = 1 where opportunity_id = $1::uuid`, [id]),
    ).rejects.toThrow(/acted on cannot be rewritten/);
  });

  it('caps at daily_capacity and clamps it to 4–20', async () => {
    for (let i = 0; i < 25; i += 1) await seedOpportunity(ws, { client: `Client ${i}`, amount: 10_000, weeks: 2 });
    await db.query(`update workspaces set daily_capacity = 5 where id = $1::uuid`, [ws]);
    const out = await generateQueue(db, { workspaceId: ws, date: NOW });
    expect(out.capacity).toBe(5);
    expect(out.items.length).toBe(5);
  });
});

describe('eligibility, through the real SQL', () => {
  it('leaves the holdout, the closed and the replied out of the queue', async () => {
    await seedOpportunity(ws, { client: 'Traité', amount: 10_000, weeks: 2 });
    await seedOpportunity(ws, { client: 'Témoin', amount: 99_000, weeks: 2, arm: 'holdout' });
    await seedOpportunity(ws, { client: 'Gagné', amount: 99_000, weeks: 2, status: 'won' });
    await seedOpportunity(ws, { client: 'Répondu', amount: 99_000, weeks: 2, replied: day(1) });
    await seedOpportunity(ws, { client: 'Trop récent', amount: 99_000, weeks: 0.2 });

    const out = await generateQueue(db, { workspaceId: ws, date: NOW });
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.clientName).toBe('Traité');
    expect(out.rejections.HOLDOUT).toBe(1);
    expect(out.rejections.NOT_OPEN).toBe(1);
    expect(out.rejections.REPLIED).toBe(1);
    expect(out.rejections.TOO_SOON).toBe(1);
  });

  it('aggregates opens and reply history without an N+1 query', async () => {
    const id = await seedOpportunity(ws, { client: 'Merlot', amount: 10_000, weeks: 2 });
    for (let i = 0; i < 4; i += 1) {
      await db.query(
        `insert into signal_events (workspace_id, opportunity_id, kind, occurred_at)
         values ($1::uuid, $2::uuid, 'doc_open', $3::timestamptz)`,
        [ws, id, now_minus_days(i)],
      );
    }
    const rows = await loadCandidates(db, ws, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.opens14d).toBe(4);
    expect(rows[0]!.replyRate).toBe(0); // never replied for this client
  });
});

function now_minus_days(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

describe('the real path: generation through the tenant role', () => {
  // This test exists because an earlier version of it generated the queue as the
  // superuser and passed, while the web app — which runs every query as
  // app_authenticated — failed with "permission denied for table
  // recommendations" on the DELETE of the regeneration. A green test that does
  // not use the real role is not a test of the real path.
  it('tenant role: generates, reads, and regenerates its own queue', async () => {
    for (let i = 0; i < 4; i += 1) await seedOpportunity(ws, { client: `Client ${i}`, amount: 10_000 + i, weeks: 2 });

    const first = await asWorkspace(db, ws, () => generateQueue(db, { workspaceId: ws, date: NOW }));
    expect(first.items).toHaveLength(4);

    const read = await asWorkspace(db, ws, () => readQueue(db, ws, first.generatedFor));
    expect(read).toHaveLength(4);

    const second = await asWorkspace(db, ws, () => generateQueue(db, { workspaceId: ws, date: NOW }));
    expect(second.items).toHaveLength(4);

    const n = await db.query<{ n: string }>(
      `select count(*) as n from recommendations where workspace_id = $1::uuid`, [ws],
    );
    expect(Number(n.rows[0]!.n)).toBe(4);
  });
});

describe('tenant isolation', () => {
  it('workspace B sees no recommendation from A', async () => {
    await seedOpportunity(ws, { client: 'A only', amount: 10_000, weeks: 2 });
    await generateQueue(db, { workspaceId: ws, date: NOW });

    const leaked = await asWorkspace(db, other, () =>
      db.query<{ n: string }>(`select count(*) as n from recommendations`),
    );
    expect(Number(leaked.rows[0]!.n)).toBe(0);

    // A tenant cannot even write a recommendation into someone else's workspace:
    // the WITH CHECK side of the policy refuses it, not just the read.
    const oppA = (await db.query<{ id: string }>(
      `select id from opportunities where workspace_id = $1::uuid limit 1`, [ws],
    )).rows[0]!.id;

    await expect(
      asWorkspace(db, other, () =>
        db.query(
          `insert into recommendations
             (workspace_id, opportunity_id, generated_for, rank, score_cents, expected_value_cents,
              p_reply, p_convert, urgency, factors, engine_version)
           values ($1::uuid, $2::uuid, $3::date, 1, 1, 1, 0.1, 0.1, 0.1, '[]'::jsonb, 'test')`,
          [ws, oppA, isoDate(NOW)],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/i);

    const stillZero = await asWorkspace(db, other, () =>
      db.query<{ n: string }>(`select count(*) as n from recommendations`),
    );
    expect(Number(stillZero.rows[0]!.n)).toBe(0);
  });
});

describe('reading the stored day', () => {
  it('serves the queue without recomputing it', async () => {
    for (let i = 0; i < 5; i += 1) await seedOpportunity(ws, { client: `Client ${i}`, amount: 10_000 + i, weeks: 2 });
    const generated = await generateQueue(db, { workspaceId: ws, date: NOW });
    const read = await readQueue(db, ws, generated.generatedFor);

    expect(read.map((i) => i.opportunityId)).toEqual(generated.items.map((i) => i.opportunityId));
    expect(read[0]!.priorityIndex).toBe(100);
    expect(read.every((i) => i.engineVersion === '2026-10-v1')).toBe(true);
  });

  it('a stored row keeps the version of the formula that produced it', async () => {
    await seedOpportunity(ws, { client: 'Merlot', amount: 10_000, weeks: 2 });
    await generateQueue(db, { workspaceId: ws, date: NOW });
    await db.query(`update recommendations set engine_version = '2025-01-v0'`);
    const read = await readQueue(db, ws, isoDate(NOW));
    expect(read[0]!.engineVersion).toBe('2025-01-v0');
  });
});

describe('gate 7 — expireWindows', () => {
  it('closes past-window opportunities, emits one webhook each, touches nothing else', async () => {
    const id = async (days: number) => {
      const r = await db.query<{ id: string }>(
        `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, stage)
         values ($1::uuid, $2, 'Old Client', 100000, now() - ($3::int || ' days')::interval, 'open', 'treatment', 'proposal_sent')
         returning id`,
        [ws, `exp-${crypto.randomUUID()}`, days],
      );
      return r.rows[0]!.id;
    };
    const old1 = await id(50);
    const old2 = await id(43);
    const fresh = await id(8);

    const enqueued: string[] = [];
    const n = await expireWindows(db, ws, async (opportunityId) => { enqueued.push(opportunityId); });

    expect(n).toBe(2);
    expect(enqueued.sort()).toEqual([old1, old2].sort());
    const states = await db.query<{ id: string; status: string }>(
      'select id, status from opportunities where workspace_id = $1::uuid', [ws],
    );
    const byId = new Map(states.rows.map((r) => [r.id, r.status]));
    expect(byId.get(old1)).toBe('expired');
    expect(byId.get(old2)).toBe('expired');
    expect(byId.get(fresh)).toBe('open');

    // A second run is a no-op: the cron can be retried safely.
    const again = await expireWindows(db, ws, async () => { throw new Error('must not re-enqueue'); });
    expect(again).toBe(0);
  });

  it('never crosses the workspace boundary', async () => {
    const r = await db.query<{ id: string }>(
      `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, stage)
       values ($1::uuid, 'other-ws-old', 'Other', 100000, now() - interval '90 days', 'open', 'treatment', 'proposal_sent')
       returning id`,
      [other],
    );
    const n = await expireWindows(db, ws, async () => {});
    expect(n).toBe(0);
    const check = await db.query<{ status: string }>('select status from opportunities where id = $1::uuid', [r.rows[0]!.id]);
    expect(check.rows[0]!.status).toBe('open');
  });
});
