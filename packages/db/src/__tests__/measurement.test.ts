/**
 * Phase 05 persistence — criteria 4, 5, 7, 8 and 10.
 *
 * The database half of the honesty suite: a snapshot that moves when nothing
 * happened, a holdout that drifts, or a tenant that sees another tenant's numbers
 * would all invalidate the report, whatever the estimator does.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createDb, truncateAll, asWorkspace, type Db } from '../client.ts';
import { createWorkspaceWithOwner } from '../repo/workspaces.ts';
import {
  isoWeekStart, addDays, weekSnapshot, writeWeek, writeAttribution, runWeek, runWeeklySnapshots,
  readResults, latestAttribution, runningExperiment, lastWeeks,
} from '../repo/measurement.ts';

let db: Db;
let workspaceId: string;

const WEEK = '2026-10-19'; // a Monday

async function seedOpportunity(o: {
  arm: 'treatment' | 'holdout';
  status?: 'open' | 'won' | 'lost' | 'expired' | 'dormant';
  amount?: number;
  sentAt: string;
  replied?: string | null;
}) {
  const id = crypto.randomUUID();
  await db.query(
    `insert into opportunities
       (id, workspace_id, client_name, amount_cents, stage, sent_at, status, arm, reply_received_at)
     values ($1::uuid, $2::uuid, $3, $4::bigint, 'proposal_sent', $5::timestamptz, $6, $7, $8::timestamptz)`,
    [
      id, workspaceId, `Client ${id.slice(0, 4)}`, o.amount ?? 1_000_000,
      o.sentAt, o.status ?? 'open', o.arm, o.replied ?? null,
    ],
  );
  return id;
}

beforeAll(async () => {
  db = await createDb({ fresh: true });
});

beforeEach(async () => {
  await truncateAll(db);
  const created = await createWorkspaceWithOwner(db, {
    email: 'mesure@studio-merlot.fr', workspaceName: 'Studio Merlot', locale: 'fr',
  });
  workspaceId = created.workspaceId;
  // The experiment must predate the cohort we measure: in production it starts
  // with the workspace, months before the first snapshot.
  await db.query(
    `update experiments set started_at = '2026-08-01T00:00:00Z' where workspace_id = $1::uuid`,
    [workspaceId],
  );
});

describe('experiments — created with the workspace, never deleted', () => {
  it('opens a running holdout experiment as soon as the workspace exists', async () => {
    const exp = await runningExperiment(db, workspaceId);
    expect(exp).not.toBeNull();
    expect(Number(exp!.rate)).toBeCloseTo(0.2, 3);
    expect(exp!.status).toBe('running');
  });

  it('refuses a second running experiment in the same workspace', async () => {
    await expect(
      db.query(
        `insert into experiments (workspace_id, kind, rate, started_at, status)
         values ($1::uuid, 'holdout', 0.2, now(), 'running')`,
        [workspaceId],
      ),
    ).rejects.toThrow();
  });

  it('keeps an invalidated experiment readable but marked as not causal', async () => {
    const exp = await runningExperiment(db, workspaceId);
    await db.query(
      `update experiments set status = 'invalidated', invalidation_reason = 'client insisted',
              ended_at = now() where id = $1::uuid`,
      [exp!.id],
    );
    expect(await runningExperiment(db, workspaceId)).toBeNull();
    const all = await db.query<{ status: string; invalidation_reason: string }>(`select status, invalidation_reason from experiments`);
    expect(all.rows[0]).toEqual({ status: 'invalidated', invalidation_reason: 'client insisted' });
  });
});

describe('weekly snapshots', () => {
  it('counts opportunities sent during the week, per arm', async () => {
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 500_000, replied: `${WEEK}T12:00:00Z` });
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T10:00:00Z` });
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T11:00:00Z`, status: 'expired' });
    await seedOpportunity({ arm: 'holdout', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 300_000 });
    await seedOpportunity({ arm: 'holdout', sentAt: `${WEEK}T09:00:00Z` });
    // Outside the week: must not be counted.
    await seedOpportunity({ arm: 'treatment', sentAt: '2026-10-26T09:00:00Z', status: 'won' });

    const snap = await weekSnapshot(db, { workspaceId, weekStart: WEEK });
    expect(snap.treatment).toEqual({ nOpportunities: 3, nReplies: 1, nWon: 1, revenueCents: 500_000, nExpired: 1 });
    expect(snap.holdout).toEqual({ nOpportunities: 2, nReplies: 0, nWon: 1, revenueCents: 300_000, nExpired: 0 });
  });

  it('is idempotent: running the week twice leaves one row per arm with identical values (criterion 7)', async () => {
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 700_000 });
    await seedOpportunity({ arm: 'holdout', sentAt: `${WEEK}T09:00:00Z` });
    const exp = await runningExperiment(db, workspaceId);

    await writeWeek(db, { workspaceId, experimentId: exp!.id, weekStart: WEEK });
    const first = await db.query<{ arm: string; n_opportunities: number; revenue_cents: string }>(
      `select arm, n_opportunities, revenue_cents from snapshots order by arm`,
    );
    await writeWeek(db, { workspaceId, experimentId: exp!.id, weekStart: WEEK });
    const second = await db.query<{ arm: string; n_opportunities: number; revenue_cents: string }>(
      `select arm, n_opportunities, revenue_cents from snapshots order by arm`,
    );

    expect(second.rows).toEqual(first.rows);
    expect(second.rows).toHaveLength(2);
  });

  it('does not let a later week change an earlier snapshot (criterion 8)', async () => {
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 400_000 });
    const exp = await runningExperiment(db, workspaceId);
    await runWeek(db, { workspaceId, weekStart: WEEK });

    const before = await db.query<{ n_opportunities: number; revenue_cents: string }>(
      `select n_opportunities, revenue_cents from snapshots where week_start = $1::date and arm = 'treatment'`,
      [WEEK],
    );
    const attributionBefore = await latestAttribution(db, workspaceId);

    // A dossier sent *after* the week closed — a won one, as tempting as it gets.
    await seedOpportunity({ arm: 'treatment', sentAt: `${addDays(WEEK, 7)}T09:00:00Z`, status: 'won', amount: 9_000_000 });
    await seedOpportunity({ arm: 'holdout', sentAt: `${addDays(WEEK, 10)}T09:00:00Z`, status: 'won', amount: 8_000_000 });

    const after = await db.query<{ n_opportunities: number; revenue_cents: string }>(
      `select n_opportunities, revenue_cents from snapshots where week_start = $1::date and arm = 'treatment'`,
      [WEEK],
    );
    expect(after.rows).toEqual(before.rows);

    // Recomputing the same week must also give the same estimate: the trailing
    // cohort is bounded by the week it describes.
    const recomputed = await writeAttribution(db, {
      workspaceId, experimentId: exp!.id, weekStart: WEEK, resamples: 200, seed: 1,
    });
    expect(recomputed.levelA.estimateCents).toBe(attributionBefore!.estimateCents);
  });

  it('runs the weekly job for every running experiment and reports what it did', async () => {
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 400_000 });
    const result = await runWeeklySnapshots(db, { now: new Date(`${WEEK}T03:00:00Z`) });
    expect(result).toMatchObject({ workspaces: 1, computed: 1, failed: 0, weekStart: WEEK });
  });
});

describe('attribution storage and reading', () => {
  it('stores one attribute row per week and serves it without recomputing', async () => {
    const exp = await runningExperiment(db, workspaceId);
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 900_000 });
    await seedOpportunity({ arm: 'holdout', sentAt: `${WEEK}T09:00:00Z` });

    await runWeek(db, { workspaceId, weekStart: WEEK });
    const stored = await latestAttribution(db, workspaceId);
    expect(stored).not.toBeNull();
    expect(stored!.nTreatment).toBe(1);
    expect(stored!.nHoldout).toBe(1);
    expect(stored!.coherenceVerdict).toBe('ok');

    // A second read returns the same row, untouched: no bootstrap on GET.
    const again = await latestAttribution(db, workspaceId);
    expect(again!.computedAt).toBe(stored!.computedAt);
    expect(again!.estimateCents).toBe(stored!.estimateCents);
    expect(exp).not.toBeNull();
  });

  it('flags a divergence between the frozen weekly revenue and the recomputed estimate (criterion 5)', async () => {
    const exp = await runningExperiment(db, workspaceId);
    const wonIds: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const id = await seedOpportunity({
        arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`,
        status: i % 3 === 0 ? 'won' : 'open', amount: 1_000_000,
      });
      if (i % 3 === 0) wonIds.push(id);
    }
    for (let i = 0; i < 10; i += 1) {
      await seedOpportunity({ arm: 'holdout', sentAt: `${WEEK}T09:00:00Z`, status: i % 5 === 0 ? 'won' : 'open', amount: 1_000_000 });
    }

    // The week is frozen first: snapshots are what the customer already saw.
    await writeWeek(db, { workspaceId, experimentId: exp!.id, weekStart: WEEK });
    const ok = await writeAttribution(db, { workspaceId, experimentId: exp!.id, weekStart: WEEK, resamples: 500, seed: 2 });
    expect(ok.coherence.verdict).toBe('ok');
    expect(Math.abs(ok.levelB.revenueCents - ok.levelC.revenueCents - ok.levelA.estimateCents)).toBeLessThanOrEqual(1000);

    // A won deal is corrected after the fact (someone fixed the amount in the CRM).
    await db.query(`update opportunities set amount_cents = 9_000_000 where id = $1::uuid`, [wonIds[0]]);

    const after = await writeAttribution(db, { workspaceId, experimentId: exp!.id, weekStart: WEEK, resamples: 500, seed: 2 });
    expect(after.levelA.estimateCents).toBeGreaterThan(ok.levelA.estimateCents);
    expect(after.coherence.verdict).toBe('investigate');
    expect(after.coherence.relativeGapPct).not.toBeNull();

    const row = await db.query<{ coherence_verdict: string; coherence_gap_cents: string }>(
      `select coherence_verdict, coherence_gap_cents from attribution_results where experiment_id = $1::uuid`,
      [exp!.id],
    );
    expect(row.rows[0]!.coherence_verdict).toBe('investigate');
    expect(Number(row.rows[0]!.coherence_gap_cents)).toBeGreaterThan(0);
  });

  it('readResults serves the screen payload with a headline that matches the state', async () => {
    const exp = await runningExperiment(db, workspaceId);
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 900_000 });
    await seedOpportunity({ arm: 'holdout', sentAt: `${WEEK}T09:00:00Z` });
    await runWeek(db, { workspaceId, weekStart: WEEK });

    const payload = await readResults(db, { workspaceId, locale: 'fr', now: new Date(`${WEEK}T10:00:00Z`) });
    expect(payload).not.toBeNull();
    expect(payload!.experiment.id).toBe(exp!.id);
    expect(payload!.attribution.estimateCents).toBe(900_000);
    expect(payload!.weeks).toHaveLength(1);
    // One holdout dossier: the only honest sentence is "not enough data".
    expect(payload!.headline.state).toBe('insufficient_data');
    expect(payload!.headline.text).not.toMatch(/rapport[ée]|gagn[ée]|r[ée]cup[ée]r/i);
  });

  it('returns the last weeks oldest-first, for the chart', async () => {
    const exp = await runningExperiment(db, workspaceId);
    for (const w of ['2026-10-05', '2026-10-12', '2026-10-19']) {
      await writeWeek(db, { workspaceId, experimentId: exp!.id, weekStart: w });
    }
    const weeks = await lastWeeks(db, workspaceId);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
  });
});

describe('4. holdout stability', () => {
  it('never moves an opportunity between arms — the trigger refuses it', async () => {
    const id = await seedOpportunity({ arm: 'holdout', sentAt: `${WEEK}T09:00:00Z` });
    await expect(
      db.query(`update opportunities set arm = 'treatment' where id = $1::uuid`, [id]),
    ).rejects.toThrow(/immutable/);

    const row = await db.query<{ arm: string; arm_assigned_at: string }>(
      `select arm, arm_assigned_at from opportunities where id = $1::uuid`, [id],
    );
    expect(row.rows[0]!.arm).toBe('holdout');
  });

  it('keeps the same holdout ids when the same file is imported three times with other amounts', async () => {
    // Importing is idempotent on `external_ref`: a re-import updates the amount,
    // not the arm, and never creates a second dossier for the same proposal.
    const refs = Array.from({ length: 40 }, (_, i) => `P-${i}`);
    const { createHash } = await import('node:crypto');
    const armFor = (ref: string) =>
      parseInt(createHash('sha1').update(ref).digest('hex').slice(0, 2), 16) / 255 < 0.2 ? 'holdout' : 'treatment';

    const insert = async (amount: number) => {
      for (const ref of refs) {
        await db.query(
          `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, arm)
           values ($1::uuid, $2, $3, $4::bigint, $5::timestamptz, $6)
           on conflict (workspace_id, external_ref) where external_ref is not null
           do update set amount_cents = excluded.amount_cents`,
          [workspaceId, ref, `Client ${ref}`, amount, `${WEEK}T09:00:00Z`, armFor(ref)],
        );
      }
    };

    await insert(1_000_000);
    const first = await holdouts();
    await insert(2_000_000);
    const second = await holdouts();
    await insert(3_000_000);
    const third = await holdouts();

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });

  async function holdouts(): Promise<string[]> {
    const res = await db.query<{ id: string }>(
      `select id from opportunities where workspace_id = $1::uuid and arm = 'holdout' order by id`,
      [workspaceId],
    );
    return res.rows.map((r) => r.id);
  }
});

describe('10. tenant isolation on the measurement tables', () => {
  it('shows a workspace nothing from another workspace', async () => {
    await seedOpportunity({ arm: 'treatment', sentAt: `${WEEK}T09:00:00Z`, status: 'won', amount: 400_000 });
    await runWeek(db, { workspaceId, weekStart: WEEK });

    const other = await createWorkspaceWithOwner(db, {
      email: 'autre@agence.fr', workspaceName: 'Agence Autre', locale: 'fr',
    });

    const mine = await asWorkspace(db, workspaceId, async () => {
      const r = await db.query<{ snaps: number; exps: number; attrs: number }>(
        `select (select count(*)::int from snapshots) as snaps,
                (select count(*)::int from experiments) as exps,
                (select count(*)::int from attribution_results) as attrs`,
      );
      return r.rows[0]!;
    });

    const theirs = await asWorkspace(db, other.workspaceId, async () => {
      const r = await db.query<{ snaps: number; exps: number; attrs: number }>(
        `select (select count(*)::int from snapshots) as snaps,
                (select count(*)::int from experiments) as exps,
                (select count(*)::int from attribution_results) as attrs`,
      );
      return r.rows[0]!;
    });

    expect(mine).toEqual({ snaps: 2, exps: 1, attrs: 1 });
    // Their own (empty) experiment is visible; nothing of ours is.
    expect(theirs).toEqual({ snaps: 0, exps: 1, attrs: 0 });
  });
});
