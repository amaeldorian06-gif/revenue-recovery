import type { Db } from '../client.ts';
import { buildQueue, clampCapacity, type QueueCandidate } from '../../../domain/src/queue/buildQueue.ts';
import { signal, STAGE_SCORE } from '../../../domain/src/scoring/signals.ts';
import { score, type ScoringConfig } from '../../../domain/src/scoring/score.ts';
import type { RejectionCode, } from '../../../domain/src/queue/eligibility.ts';
import { GATES } from '../../../domain/src/queue/eligibility.ts';
import type { Factor } from '../../../domain/src/scoring/score.ts';

/**
 * Generation and persistence of the daily queue.
 *
 * Two rules that are easy to get wrong and expensive to debug:
 *   • the whole candidate set is loaded in **one** query with the signals
 *     aggregated in SQL — no N+1, the 5 000-dossier benchmark is on this file;
 *   • regeneration is idempotent and never erases a decision the user already
 *     acted on (a row with `acted = true` survives and keeps its rank).
 */

export interface QueueRow {
  id: string;
  clientName: string;
  title: string | null;
  amountCents: number;
  stage: string;
  sentAt: string;
  lastTouchAt: string | null;
  touchCount: number;
  status: string;
  arm: 'treatment' | 'holdout';
  replyReceivedAt: string | null;
  contactEmail: string | null;
  contactOptedOut: boolean;
  opens14d: number;
  replyRate: number | null;
  wonDeals: number;
}

export interface QueueItemView {
  opportunityId: string;
  rank: number;
  priorityIndex: number;
  clientName: string;
  title: string | null;
  amountCents: number;
  stage: string;
  sentAt: string;
  contactEmail: string | null;
  scoreCents: number;
  expectedValueCents: number;
  pReply: number;
  pConvert: number;
  urgency: number;
  factors: Factor[];
  engineVersion: string;
  acted: boolean;
  /** Observable facts the card shows as badges. */
  opens14d: number;
  touchCount: number;
}

export interface GenerationResult {
  generatedFor: string;
  items: QueueItemView[];
  totalOpportunities: number;
  rejections: Record<RejectionCode, number>;
  rejectedTotal: number;
  capacity: number;
  actedKept: number;
}

/** ISO date (workspace-local) of an instant, without pulling in a date library. */
export function isoDate(d: Date, timeZone = 'Europe/Paris'): string {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/**
 * One query, all the facts the engine needs. `per_client` is computed once and
 * joined, which is what keeps the endpoint under 400 ms on 5 000 dossiers.
 */
export async function loadCandidates(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<QueueRow[]> {
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const res = await db.query<{
    id: string; client_name: string; title: string | null; amount_cents: string; stage: string;
    sent_at: string; last_touch_at: string | null; touch_count: number; status: string;
    arm: 'treatment' | 'holdout'; reply_received_at: string | null; email: string | null;
    opt_out_at: string | null; opens_14d: string; reply_rate: string | null; won_deals: string;
  }>(
    `with per_client as (
       select lower(client_name) as key,
              avg(case when reply_received_at is not null then 1.0 else 0.0 end) as reply_rate,
              count(*) filter (where status = 'won') as won_deals
         from opportunities
        where workspace_id = $1::uuid
        group by lower(client_name)
     ),
     opens as (
       select opportunity_id, count(*) as opens_14d
         from signal_events
        where workspace_id = $1::uuid
          and kind in ('doc_open','email_open')
          and occurred_at >= $2::timestamptz
        group by opportunity_id
     )
     select o.id, o.client_name, o.title, o.amount_cents, o.stage, o.sent_at,
            o.last_touch_at, o.touch_count, o.status, o.arm, o.reply_received_at,
            c.email, c.opt_out_at,
            coalesce(op.opens_14d, 0) as opens_14d,
            pc.reply_rate, pc.won_deals
       from opportunities o
       left join contacts c on c.id = o.contact_id
       join per_client pc on pc.key = lower(o.client_name)
       left join opens op on op.opportunity_id = o.id
      where o.workspace_id = $1::uuid`,
    [workspaceId, since],
  );

  return res.rows.map((r) => ({
    id: r.id,
    clientName: r.client_name,
    title: r.title,
    amountCents: Number(r.amount_cents),
    stage: r.stage,
    sentAt: r.sent_at,
    lastTouchAt: r.last_touch_at,
    touchCount: r.touch_count,
    status: r.status,
    arm: r.arm,
    replyReceivedAt: r.reply_received_at,
    contactEmail: r.email,
    contactOptedOut: r.opt_out_at !== null,
    opens14d: Number(r.opens_14d),
    replyRate: r.reply_rate === null ? null : Number(r.reply_rate),
    wonDeals: Number(r.won_deals),
  }));
}

export interface GenerateOptions {
  workspaceId: string;
  date?: Date;
  timeZone?: string;
  capacity?: number | null;
  config?: Partial<ScoringConfig>;
  holidays?: readonly string[];
  /** Test hook: skips the write. Used by the benchmark. */
  dryRun?: boolean;
}

/**
 * Generate the queue for a date and persist it. Reads are served from
 * `recommendations` afterwards — the table *is* the cache.
 */
export async function generateQueue(db: Db, opts: GenerateOptions): Promise<GenerationResult> {
  const now = opts.date ?? new Date();
  const generatedFor = isoDate(now, opts.timeZone ?? 'Europe/Paris');

  const ws = await db.query<{ daily_capacity: number; scoring_config: Record<string, unknown> }>(
    `select daily_capacity, scoring_config from workspaces where id = $1::uuid`,
    [opts.workspaceId],
  );
  const capacity = clampCapacity(opts.capacity ?? ws.rows[0]?.daily_capacity ?? 8);
  const config = { ...(ws.rows[0]?.scoring_config ?? {}), ...(opts.config ?? {}) };

  const acted = await db.query<{ opportunity_id: string; rank: number }>(
    `select opportunity_id, rank from recommendations
      where workspace_id = $1::uuid and generated_for = $2::date and acted`,
    [opts.workspaceId, generatedFor],
  );
  const actedIds = new Set(acted.rows.map((r) => r.opportunity_id));
  const actedKept = acted.rows.length;
  const slotsLeft = Math.max(0, capacity - actedKept);

  const rows = await loadCandidates(db, opts.workspaceId, now);

  const candidates: QueueCandidate[] = rows
    .filter((r) => !actedIds.has(r.id))
    .map((r) => {
      const weeks = Math.max(0, (now.getTime() - new Date(r.sentAt).getTime()) / (7 * 86_400_000));
      const sig = signal({
        opens14d: r.opens14d,
        replyHistoryRate: r.replyRate,
        wonDealsWithClient: r.wonDeals,
        stage: r.stage,
      });
      return {
        id: r.id,
        clientName: r.clientName,
        amountCents: r.amountCents,
        sentAt: new Date(r.sentAt),
        lastTouchAt: r.lastTouchAt ? new Date(r.lastTouchAt) : null,
        touchCount: r.touchCount,
        status: r.status,
        arm: r.arm,
        replyReceivedAt: r.replyReceivedAt ? new Date(r.replyReceivedAt) : null,
        contactOptedOut: r.contactOptedOut,
        score: score({
          amountCents: r.amountCents,
          weeksSinceSend: weeks,
          signal: sig.value,
          annoyed: r.touchCount >= 3,
          config,
          context: {
            opens14d: r.opens14d,
            stage: r.stage,
            stageScore: STAGE_SCORE[r.stage] ?? STAGE_SCORE.other,
            replyHistoryRate: r.replyRate,
          },
        }),
      } satisfies QueueCandidate;
    });

  const built = buildQueue(candidates, {
    now,
    capacity: slotsLeft,
    holidays: opts.holidays ?? [],
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const maxScore = Math.max(
    1,
    ...built.items.map((i) => i.scoreCents),
    ...acted.rows.map(() => 0),
  );

  const items: QueueItemView[] = built.items.map((item) => {
    const row = byId.get(item.opportunityId)!;
    return {
      opportunityId: item.opportunityId,
      rank: item.rank,
      priorityIndex: Math.round((100 * item.scoreCents) / maxScore),
      clientName: row.clientName,
      title: row.title,
      amountCents: row.amountCents,
      stage: row.stage,
      sentAt: row.sentAt,
      contactEmail: row.contactEmail,
      scoreCents: item.scoreCents,
      expectedValueCents: item.expectedValueCents,
      pReply: item.pReply,
      pConvert: item.pConvert,
      urgency: item.urgency,
      factors: item.factors,
      engineVersion: item.engineVersion,
      acted: false,
      opens14d: row.opens14d,
      touchCount: row.touchCount,
    };
  });

  if (!opts.dryRun) {
    await persistQueue(db, opts.workspaceId, generatedFor, items);
  }

  return {
    generatedFor,
    items,
    totalOpportunities: rows.length,
    rejections: built.rejections.byCode,
    rejectedTotal: built.rejections.total,
    capacity,
    actedKept,
  };
}

/**
 * Transactional replace of the day's rows. The `where` clause on the upsert is
 * the whole point: an acted row is never overwritten, even if the opportunity
 * somehow reappears in the candidate set.
 */
export async function persistQueue(
  db: Db,
  workspaceId: string,
  generatedFor: string,
  items: readonly QueueItemView[],
): Promise<void> {
  await db.exec('begin');
  try {
    await db.query(
      `delete from recommendations
        where workspace_id = $1::uuid and generated_for = $2::date and not acted`,
      [workspaceId, generatedFor],
    );
    for (const it of items) {
      await db.query(
        `insert into recommendations
           (workspace_id, opportunity_id, generated_for, rank, score_cents, expected_value_cents,
            p_reply, p_convert, urgency, factors, engine_version)
         values ($1::uuid, $2::uuid, $3::date, $4, $5::bigint, $6::bigint, $7, $8, $9, $10::jsonb, $11)
         on conflict (workspace_id, generated_for, opportunity_id) do update
           set rank = excluded.rank,
               score_cents = excluded.score_cents,
               expected_value_cents = excluded.expected_value_cents,
               p_reply = excluded.p_reply,
               p_convert = excluded.p_convert,
               urgency = excluded.urgency,
               factors = excluded.factors,
               engine_version = excluded.engine_version
           where recommendations.acted = false`,
        [
          workspaceId, it.opportunityId, generatedFor, it.rank, it.scoreCents,
          it.expectedValueCents, it.pReply, it.pConvert, it.urgency,
          JSON.stringify(it.factors), it.engineVersion,
        ],
      );
    }
    await db.exec('commit');
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}

/** Serve the stored day. No recomputation: the table is the cache. */
export async function readQueue(
  db: Db,
  workspaceId: string,
  generatedFor: string,
): Promise<QueueItemView[]> {
  const res = await db.query<{
    opportunity_id: string; rank: number; score_cents: string; expected_value_cents: string;
    p_reply: string; p_convert: string; urgency: string; factors: Factor[];
    engine_version: string; acted: boolean; client_name: string; title: string | null;
    amount_cents: string; stage: string; sent_at: string; email: string | null;
    touch_count: number;
  }>(
    `select r.opportunity_id, r.rank, r.score_cents, r.expected_value_cents,
            r.p_reply, r.p_convert, r.urgency, r.factors, r.engine_version, r.acted,
            o.client_name, o.title, o.amount_cents, o.stage, o.sent_at, o.touch_count, c.email
       from recommendations r
       join opportunities o on o.id = r.opportunity_id
       left join contacts c on c.id = o.contact_id
      where r.workspace_id = $1::uuid and r.generated_for = $2::date
      order by r.rank asc`,
    [workspaceId, generatedFor],
  );

  const maxScore = Math.max(1, ...res.rows.map((r) => Number(r.score_cents)));

  return res.rows.map((r) => ({
    opportunityId: r.opportunity_id,
    rank: r.rank,
    priorityIndex: Math.round((100 * Number(r.score_cents)) / maxScore),
    clientName: r.client_name,
    title: r.title,
    amountCents: Number(r.amount_cents),
    stage: r.stage,
    sentAt: r.sent_at,
    contactEmail: r.email,
    scoreCents: Number(r.score_cents),
    expectedValueCents: Number(r.expected_value_cents),
    pReply: Number(r.p_reply),
    pConvert: Number(r.p_convert),
    urgency: Number(r.urgency),
    factors: r.factors,
    engineVersion: r.engine_version,
    acted: r.acted,
    // Opens are not stored on the row: they are a live signal, and faking a
    // stored value would make the badge lie after the first regeneration.
    opens14d: 0,
    touchCount: r.touch_count,
  }));
}

/** Everything the empty state needs to explain itself. */
export async function rejectionSummary(
  db: Db,
  workspaceId: string,
  now: Date,
): Promise<{ byCode: Record<RejectionCode, number>; total: number }> {
  const rows = await loadCandidates(db, workspaceId, now);
  const built = buildQueue(
    rows.map((r) => ({
      id: r.id, clientName: r.clientName, amountCents: r.amountCents,
      sentAt: new Date(r.sentAt),
      lastTouchAt: r.lastTouchAt ? new Date(r.lastTouchAt) : null,
      touchCount: r.touchCount, status: r.status, arm: r.arm,
      replyReceivedAt: r.replyReceivedAt ? new Date(r.replyReceivedAt) : null,
      contactOptedOut: r.contactOptedOut,
      score: score({ amountCents: r.amountCents, weeksSinceSend: 1, signal: 0.4, annoyed: false }),
    })),
    { now, capacity: 0 },
  );
  return built.rejections;
}

/**
 * Gate 7, applied by the daily cron: an opportunity whose six-week window has
 * closed leaves the pipeline with a status — not by disappearing — and each
 * closing emits `opportunity.expired` to the workspace's subscribers. The
 * webhooks are enqueued in the same pass so the CRM mirror and the queue never
 * disagree about why a dossier vanished.
 */
export async function expireWindows(
  db: Db,
  workspaceId: string,
  enqueue: (opportunityId: string) => Promise<unknown>,
): Promise<number> {
  const closed = await db.query<{ id: string }>(
    `update opportunities
       set status = 'expired', closed_at = now(), updated_at = now()
     where workspace_id = $1::uuid and status = 'open'
       and sent_at < now() - ($2::int || ' days')::interval
     returning id`,
    [workspaceId, GATES.MAX_WEEKS * 7],
  );
  for (const row of closed.rows) {
    await enqueue(row.id);
  }
  return closed.rows.length;
}
