import type { Db } from '../client.ts';
import {
  attribute, type AttributionResult, type OutcomeRow,
} from '../../../domain/src/measurement/attribution.ts';
import { headline, type Headline } from '../../../domain/src/measurement/headline.ts';

/**
 * Measurement persistence.
 *
 * Two choices are visible here and both are deliberate:
 *   • a `snapshots` row is the cohort of opportunities **sent during that week**
 *     (incremental), not a rolling window. Stacking twelve of them gives exactly
 *     the trailing cohort §10.1 asks for, while keeping each week's row stable
 *     forever — a row that changes every Monday cannot be audited.
 *   • the attribution is computed once per week and stored. The results screen
 *     reads one row; it never runs 10 000 resamples because someone pressed F5.
 */

export const COHORT_WEEKS = 12;
const DAY = 86_400_000;

export interface ArmSnapshot {
  nOpportunities: number;
  nReplies: number;
  nWon: number;
  revenueCents: number;
  nExpired: number;
}

export interface WeekSnapshot {
  weekStart: string;
  treatment: ArmSnapshot;
  holdout: ArmSnapshot;
}

export interface ExperimentRow {
  id: string;
  workspace_id: string;
  rate: string;
  started_at: string;
  status: 'running' | 'stopped' | 'invalidated';
  invalidation_reason: string | null;
}

export interface StoredAttribution {
  weekStart: string;
  estimateCents: number;
  ciLow: number;
  ciHigh: number;
  pValue: number;
  significant: boolean;
  nTreatment: number;
  nHoldout: number;
  revenueBCents: number;
  revenueCCents: number;
  requiredPerArm: number | null;
  coherenceVerdict: 'ok' | 'investigate';
  coherenceGapCents: number;
  computedAt: string;
}

/** Monday 00:00 UTC of the week containing `d`. */
export function isoWeekStart(d: Date): string {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = utc.getUTCDay(); // 0 = Sunday
  const delta = dow === 0 ? -6 : 1 - dow;
  utc.setUTCDate(utc.getUTCDate() + delta);
  return utc.toISOString().slice(0, 10);
}

/** PGlite returns `date` columns as Date objects; the API and the tests speak ISO. */
export function toIsoDate(v: string | Date): string {
  return typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(new Date(`${isoDate}T00:00:00Z`).getTime() + days * DAY).toISOString().slice(0, 10);
}

export async function runningExperiment(db: Db, workspaceId: string): Promise<ExperimentRow | null> {
  const res = await db.query<ExperimentRow>(
    `select id, workspace_id, rate, started_at, status, invalidation_reason
       from experiments
      where workspace_id = $1::uuid and status = 'running'
      order by started_at desc limit 1`,
    [workspaceId],
  );
  return res.rows[0] ?? null;
}

const EMPTY: ArmSnapshot = { nOpportunities: 0, nReplies: 0, nWon: 0, revenueCents: 0, nExpired: 0 };

/**
 * Counters for the opportunities sent during `[weekStart, weekStart + 7 days)`.
 * Returns both arms even when empty: a missing row and a zero row must not be
 * two different things for the reader of the weekly log.
 */
export async function weekSnapshot(
  db: Db,
  input: { workspaceId: string; weekStart: string },
): Promise<WeekSnapshot> {
  const from = input.weekStart;
  const to = addDays(input.weekStart, 7);
  const res = await db.query<{
    arm: 'treatment' | 'holdout'; n_opportunities: number; n_replies: number;
    n_won: number; revenue_cents: string; n_expired: number;
  }>(
    `select o.arm,
            count(*)::int as n_opportunities,
            count(*) filter (where o.reply_received_at is not null)::int as n_replies,
            count(*) filter (where o.status = 'won')::int as n_won,
            coalesce(sum(o.amount_cents) filter (where o.status = 'won'), 0)::text as revenue_cents,
            count(*) filter (where o.status = 'expired')::int as n_expired
       from opportunities o
      where o.workspace_id = $1::uuid
        and o.sent_at >= $2::timestamptz
        and o.sent_at <  $3::timestamptz
      group by o.arm`,
    [input.workspaceId, `${from}T00:00:00Z`, `${to}T00:00:00Z`],
  );

  const byArm = new Map(res.rows.map((r) => [r.arm, r]));
  const pick = (arm: 'treatment' | 'holdout'): ArmSnapshot => {
    const r = byArm.get(arm);
    if (!r) return { ...EMPTY };
    return {
      nOpportunities: r.n_opportunities,
      nReplies: r.n_replies,
      nWon: r.n_won,
      revenueCents: Number(r.revenue_cents),
      nExpired: r.n_expired,
    };
  };
  return { weekStart: from, treatment: pick('treatment'), holdout: pick('holdout') };
}

/** Upsert both arms for one week. Idempotent by construction. */
export async function writeWeek(db: Db, input: {
  workspaceId: string; experimentId: string; weekStart: string;
}): Promise<WeekSnapshot> {
  const snap = await weekSnapshot(db, { workspaceId: input.workspaceId, weekStart: input.weekStart });
  for (const arm of ['treatment', 'holdout'] as const) {
    const s = snap[arm];
    await db.query(
      `insert into snapshots
         (workspace_id, experiment_id, week_start, arm, n_opportunities, n_replies, n_won, revenue_cents, n_expired)
       values ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8::bigint, $9)
       on conflict (experiment_id, week_start, arm) do update
         set n_opportunities = excluded.n_opportunities,
             n_replies = excluded.n_replies,
             n_won = excluded.n_won,
             revenue_cents = excluded.revenue_cents,
             n_expired = excluded.n_expired,
             computed_at = now()`,
      [input.workspaceId, input.experimentId, input.weekStart, arm,
       s.nOpportunities, s.nReplies, s.nWon, s.revenueCents, s.nExpired],
    );
  }
  return snap;
}

/** Per-opportunity outcomes of the trailing cohort ending at `weekStart`. */
export async function cohortRows(db: Db, input: {
  workspaceId: string; experimentId: string; weekStart: string;
}): Promise<OutcomeRow[]> {
  const from = addDays(input.weekStart, -7 * (COHORT_WEEKS - 1));
  const to = addDays(input.weekStart, 7);
  const res = await db.query<{ arm: 'treatment' | 'holdout'; won: boolean; amount_cents: string; sent_at: string }>(
    `select o.arm, (o.status = 'won') as won, o.amount_cents::text, o.sent_at
       from opportunities o
       join experiments e on e.id = $2::uuid
      where o.workspace_id = $1::uuid
        and o.sent_at >= $3::timestamptz
        and o.sent_at <  $4::timestamptz
        -- Never measure before the experiment existed: a holdout that did not
        -- exist yet cannot have withheld anything.
        and o.sent_at >= e.started_at`,
    [input.workspaceId, input.experimentId, `${from}T00:00:00Z`, `${to}T00:00:00Z`],
  );
  return res.rows.map((r) => ({
    arm: r.arm,
    won: r.won,
    amountCents: Number(r.amount_cents),
    sentAt: r.sent_at,
  }));
}

/** Sum of the stored snapshot revenue over the trailing cohort window. */
export async function storedCohortRevenue(db: Db, input: {
  workspaceId: string; experimentId: string; weekStart: string;
}): Promise<{ treatmentCents: number; holdoutCents: number; weeks: number } | null> {
  const from = addDays(input.weekStart, -7 * (COHORT_WEEKS - 1));
  const res = await db.query<{ arm: 'treatment' | 'holdout'; revenue_cents: string; weeks: string }>(
    `select arm, sum(revenue_cents)::text as revenue_cents, count(*)::text as weeks
       from snapshots
      where experiment_id = $1::uuid
        and week_start >= $2::date and week_start <= $3::date
      group by arm`,
    [input.experimentId, from, input.weekStart],
  );
  if (res.rows.length === 0) return null;
  const byArm = new Map(res.rows.map((r) => [r.arm, Number(r.revenue_cents)]));
  return {
    treatmentCents: byArm.get('treatment') ?? 0,
    holdoutCents: byArm.get('holdout') ?? 0,
    weeks: Number(res.rows[0]?.weeks ?? 0),
  };
}

/**
 * The stored gross figures come from the snapshots, the causal estimate from the
 * raw cohort. They are computed from the same data on purpose — a divergence can
 * then only come from a real inconsistency (a corrected amount, a manual status
 * change), which is precisely what the coherence check is for.
 */
export async function writeAttribution(db: Db, input: {
  workspaceId: string; experimentId: string; weekStart: string; seed?: number; resamples?: number;
}): Promise<AttributionResult> {
  const rows = await cohortRows(db, input);

  // B and C come from the *stored* weekly snapshots, not from the rows. That is
  // the whole point of the coherence check: if a deal amount is corrected after
  // its week was frozen, the recorded revenue and the recomputed estimate stop
  // agreeing, and we want to know before the customer does.
  const stored = await storedCohortRevenue(db, {
    workspaceId: input.workspaceId,
    experimentId: input.experimentId,
    weekStart: input.weekStart,
  });

  const result = attribute(rows, {
    seed: input.seed,
    resamples: input.resamples,
    storedTreatmentCents: stored?.treatmentCents,
    storedHoldoutCents: stored?.holdoutCents,
  });

  await db.query(
    `insert into attribution_results
       (workspace_id, experiment_id, week_start, estimate_cents, ci_low_cents, ci_high_cents,
        relative_effect, p_value, significant, n_treatment, n_holdout, revenue_b_cents,
        revenue_c_cents, required_per_arm, coherence_verdict, coherence_gap_cents)
     values ($1::uuid, $2::uuid, $3::date, $4::bigint, $5::bigint, $6::bigint, $7, $8,
             $9, $10, $11, $12::bigint, $13::bigint, $14, $15, $16::bigint)
     on conflict (experiment_id, week_start) do update
       set estimate_cents = excluded.estimate_cents,
           ci_low_cents = excluded.ci_low_cents,
           ci_high_cents = excluded.ci_high_cents,
           relative_effect = excluded.relative_effect,
           p_value = excluded.p_value,
           significant = excluded.significant,
           n_treatment = excluded.n_treatment,
           n_holdout = excluded.n_holdout,
           revenue_b_cents = excluded.revenue_b_cents,
           revenue_c_cents = excluded.revenue_c_cents,
           required_per_arm = excluded.required_per_arm,
           coherence_verdict = excluded.coherence_verdict,
           coherence_gap_cents = excluded.coherence_gap_cents,
           computed_at = now()`,
    [
      input.workspaceId, input.experimentId, input.weekStart,
      result.levelA.estimateCents, result.levelA.ciLow, result.levelA.ciHigh,
      result.levelA.relativeEffect, result.levelA.pValue, result.levelA.significant,
      result.levelA.nTreatment, result.levelA.nHoldout,
      result.levelB.revenueCents, result.levelC.revenueCents,
      result.requiredSample?.perArm ?? null,
      result.coherence.verdict, Math.abs(result.coherence.bMinusC - result.coherence.a),
    ],
  );
  return result;
}

/** One week, end to end: snapshots then attribution. Idempotent. */
export async function runWeek(db: Db, input: {
  workspaceId: string; weekStart: string; seed?: number;
}): Promise<{ snapshot: WeekSnapshot; attribution: AttributionResult }> {
  const experiment = await runningExperiment(db, input.workspaceId);
  if (!experiment) throw new Error('no running experiment for this workspace');
  const snapshot = await writeWeek(db, {
    workspaceId: input.workspaceId, experimentId: experiment.id, weekStart: input.weekStart,
  });
  const attribution = await writeAttribution(db, {
    workspaceId: input.workspaceId, experimentId: experiment.id, weekStart: input.weekStart, seed: input.seed,
  });
  return { snapshot, attribution };
}

export interface WeeklyJobResult {
  workspaces: number;
  computed: number;
  failed: number;
  weekStart: string;
  durationMs: number;
}

/**
 * The Monday 03:00 job. One week per running experiment; running it twice is
 * harmless, which is what makes a cron safe to retry.
 */
export async function runWeeklySnapshots(db: Db, opts: { now?: Date } = {}): Promise<WeeklyJobResult> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const weekStart = isoWeekStart(now);

  const experiments = await db.query<{ workspace_id: string }>(
    `select workspace_id from experiments where status = 'running'`,
  );

  let computed = 0;
  let failed = 0;
  for (const e of experiments.rows) {
    try {
      await runWeek(db, { workspaceId: e.workspace_id, weekStart });
      computed += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    workspaces: experiments.rows.length,
    computed,
    failed,
    weekStart,
    durationMs: Date.now() - started,
  };
}

// --------------------------------------------------------------- read side

export interface ResultsPayload {
  experiment: ExperimentRow;
  weekStart: string;
  weeks: WeekSnapshot[];
  attribution: StoredAttribution;
  headline: Headline;
  /** Cumulative revenue per week, for the chart. */
  series: Array<{ weekStart: string; treatmentCents: number; holdoutCents: number }>;
  weeksMeasured: number;
  holdoutCount: number;
}

function toStored(r: {
  week_start: string | Date; estimate_cents: string; ci_low_cents: string; ci_high_cents: string;
  p_value: string; significant: boolean; n_treatment: number; n_holdout: number;
  revenue_b_cents: string; revenue_c_cents: string; required_per_arm: number | null;
  coherence_verdict: 'ok' | 'investigate'; coherence_gap_cents: string; computed_at: string;
}): StoredAttribution {
  return {
    weekStart: toIsoDate(r.week_start),
    estimateCents: Number(r.estimate_cents),
    ciLow: Number(r.ci_low_cents),
    ciHigh: Number(r.ci_high_cents),
    pValue: Number(r.p_value),
    significant: r.significant,
    nTreatment: r.n_treatment,
    nHoldout: r.n_holdout,
    revenueBCents: Number(r.revenue_b_cents),
    revenueCCents: Number(r.revenue_c_cents),
    requiredPerArm: r.required_per_arm,
    coherenceVerdict: r.coherence_verdict,
    coherenceGapCents: Number(r.coherence_gap_cents),
    computedAt: new Date(r.computed_at).toISOString(),
  };
}

const SELECT_STORED = `select week_start, estimate_cents, ci_low_cents, ci_high_cents, p_value,
                              significant, n_treatment, n_holdout, revenue_b_cents, revenue_c_cents,
                              required_per_arm, coherence_verdict, coherence_gap_cents, computed_at
                         from attribution_results`;

/** Latest stored attribution, without computing anything. */
export async function latestAttribution(db: Db, workspaceId: string): Promise<StoredAttribution | null> {
  const res = await db.query<Parameters<typeof toStored>[0]>(
    `${SELECT_STORED} where workspace_id = $1::uuid order by week_start desc limit 1`,
    [workspaceId],
  );
  return res.rows[0] ? toStored(res.rows[0]) : null;
}

export async function lastWeeks(db: Db, workspaceId: string, count = COHORT_WEEKS): Promise<WeekSnapshot[]> {
  const res = await db.query<{
    week_start: string | Date; arm: 'treatment' | 'holdout'; n_opportunities: number; n_replies: number;
    n_won: number; revenue_cents: string; n_expired: number;
  }>(
    `select week_start, arm, n_opportunities, n_replies, n_won, revenue_cents, n_expired
       from snapshots
      where workspace_id = $1::uuid
      order by week_start desc, arm
      limit $2`,
    [workspaceId, count * 2],
  );

  const byWeek = new Map<string, WeekSnapshot>();
  for (const r of res.rows) {
    const weekStart = toIsoDate(r.week_start);
    const w = byWeek.get(weekStart) ?? {
      weekStart, treatment: { ...EMPTY }, holdout: { ...EMPTY },
    };
    w[r.arm] = {
      nOpportunities: r.n_opportunities,
      nReplies: r.n_replies,
      nWon: r.n_won,
      revenueCents: Number(r.revenue_cents),
      nExpired: r.n_expired,
    };
    byWeek.set(weekStart, w);
  }
  return [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

/**
 * Everything `/results` needs, in four indexed queries. The attribution is read,
 * never recomputed — except on the very first visit of a workspace that has no
 * stored week yet, where computing once is cheaper than showing nothing.
 */
export async function readResults(db: Db, input: {
  workspaceId: string; locale?: 'fr' | 'en'; now?: Date;
}): Promise<ResultsPayload | null> {
  const experiment = await runningExperiment(db, input.workspaceId);
  if (!experiment) return null;
  const now = input.now ?? new Date();
  const weekStart = isoWeekStart(now);

  let stored = await latestAttribution(db, input.workspaceId);
  if (!stored) {
    await writeAttribution(db, { workspaceId: input.workspaceId, experimentId: experiment.id, weekStart });
    stored = await latestAttribution(db, input.workspaceId);
  }
  if (!stored) return null;

  const weeks = await lastWeeks(db, input.workspaceId);

  const holdout = await db.query<{ held: string; treated: string }>(
    `select count(*) filter (where arm = 'holdout')::text as held,
            count(*) filter (where arm = 'treatment')::text as treated
       from opportunities where workspace_id = $1::uuid`,
    [input.workspaceId],
  );

  let cumT = 0;
  let cumH = 0;
  const series = weeks.map((w) => {
    cumT += w.treatment.revenueCents;
    cumH += w.holdout.revenueCents;
    return { weekStart: w.weekStart, treatmentCents: cumT, holdoutCents: cumH };
  });

  const weeksMeasured = Math.max(1, weeks.length);
  const headlineInput = {
    levelA: {
      estimateCents: stored.estimateCents,
      ciLow: stored.ciLow,
      ciHigh: stored.ciHigh,
      significant: stored.significant,
      nTreatment: stored.nTreatment,
      nHoldout: stored.nHoldout,
    },
    requiredSample:
      stored.requiredPerArm === null
        ? null
        : {
            perArm: stored.requiredPerArm,
            currentPerArm: Math.min(stored.nTreatment, stored.nHoldout),
            progressPct: Math.min(
              100,
              Math.round((100 * Math.min(stored.nTreatment, stored.nHoldout)) / Math.max(1, stored.requiredPerArm)),
            ),
          },
    weeksMeasured,
  };

  return {
    experiment,
    weekStart: stored.weekStart,
    weeks,
    attribution: stored,
    headline: headline(headlineInput, input.locale ?? 'fr'),
    series,
    weeksMeasured,
    holdoutCount: Number(holdout.rows[0]?.held ?? 0),
  };
}

/** The admin view's data: every stored week, coherence verdict included. */
export async function coherenceReport(db: Db, workspaceId?: string) {
  const res = await db.query<{
    workspace_id: string; workspace_name: string; week_start: string;
    estimate_cents: string; ci_low_cents: string; ci_high_cents: string;
    revenue_b_cents: string; revenue_c_cents: string;
    coherence_verdict: 'ok' | 'investigate'; coherence_gap_cents: string; computed_at: string;
  }>(
    `select a.workspace_id, w.name as workspace_name, a.week_start, a.estimate_cents,
            a.ci_low_cents, a.ci_high_cents, a.revenue_b_cents, a.revenue_c_cents,
            a.coherence_verdict, a.coherence_gap_cents, a.computed_at
       from attribution_results a
       join workspaces w on w.id = a.workspace_id
      where ($1::uuid is null or a.workspace_id = $1::uuid)
      order by a.coherence_verdict desc, a.week_start desc
      limit 100`,
    [workspaceId ?? null],
  );
  return res.rows.map((r) => ({
    workspaceId: r.workspace_id,
    workspaceName: r.workspace_name,
    weekStart: toIsoDate(r.week_start),
    estimateCents: Number(r.estimate_cents),
    ciLow: Number(r.ci_low_cents),
    ciHigh: Number(r.ci_high_cents),
    revenueBCents: Number(r.revenue_b_cents),
    revenueCCents: Number(r.revenue_c_cents),
    verdict: r.coherence_verdict,
    gapCents: Number(r.coherence_gap_cents),
    computedAt: r.computed_at,
  }));
}
