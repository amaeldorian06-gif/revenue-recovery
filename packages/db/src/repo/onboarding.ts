import type { Db } from '../client.ts';

/**
 * Onboarding persistence + the seeded demo portfolio. Everything here is
 * resumable by construction: the wizard state lives in `onboarding_state`, so
 * a refresh, a closed tab or a second browser land on the same step.
 */

export class DemoDataConflictError extends Error {
  constructor(public existingReal: number) {
    super(`workspace already holds ${existingReal} non-demo opportunities`);
  }
}

// ---------------------------------------------------------------- state

export interface OnboardingState {
  currentStep: number;
  stepsDone: string[];
  stagedImportId: string | null;
  timezone: string | null;
  mailboxChoice: 'gmail' | 'smtp_imap' | 'later' | null;
  demoData: boolean;
  signupCompletedAt: Date | null;
  calibrationSeenAt: Date | null;
  firstQueueAt: Date | null;
  coachDismissedAt: Date | null;
}

export async function getOnboardingState(db: Db, workspaceId: string): Promise<OnboardingState> {
  await db.query(
    `insert into onboarding_state (workspace_id) values ($1::uuid)
     on conflict (workspace_id) do nothing`,
    [workspaceId],
  );
  const r = await db.query<{
    current_step: number; steps_done: string[]; staged_import_id: string | null;
    timezone: string | null; mailbox_choice: OnboardingState['mailboxChoice'];
    demo_data: boolean; signup_completed_at: string | null; calibration_seen_at: string | null;
    first_queue_at: string | null; coach_dismissed_at: string | null;
  }>(
    `select current_step, steps_done, staged_import_id, timezone, mailbox_choice, demo_data,
            signup_completed_at, calibration_seen_at, first_queue_at, coach_dismissed_at
       from onboarding_state where workspace_id = $1::uuid`,
    [workspaceId],
  );
  const row = r.rows[0]!;
  return {
    currentStep: row.current_step,
    stepsDone: row.steps_done ?? [],
    stagedImportId: row.staged_import_id,
    timezone: row.timezone,
    mailboxChoice: row.mailbox_choice,
    demoData: row.demo_data,
    signupCompletedAt: row.signup_completed_at ? new Date(row.signup_completed_at) : null,
    calibrationSeenAt: row.calibration_seen_at ? new Date(row.calibration_seen_at) : null,
    firstQueueAt: row.first_queue_at ? new Date(row.first_queue_at) : null,
    coachDismissedAt: row.coach_dismissed_at ? new Date(row.coach_dismissed_at) : null,
  };
}

export interface OnboardingPatch {
  step?: number;
  stepDone?: string;
  stagedImportId?: string | null;
  timezone?: string | null;
  mailboxChoice?: 'gmail' | 'smtp_imap' | 'later' | null;
}

export async function patchOnboardingState(db: Db, workspaceId: string, patch: OnboardingPatch): Promise<void> {
  await getOnboardingState(db, workspaceId);
  if (patch.stepDone !== undefined) {
    await db.query(
      `update onboarding_state
         set steps_done = (select jsonb_agg(distinct x) from jsonb_array_elements(steps_done || to_jsonb($2::text)) x),
             current_step = greatest(current_step, $3),
             updated_at = now()
       where workspace_id = $1::uuid`,
      [workspaceId, patch.stepDone, patch.step ?? 1],
    );
  } else if (patch.step !== undefined) {
    await db.query(
      `update onboarding_state set current_step = greatest(current_step, $2), updated_at = now()
       where workspace_id = $1::uuid`,
      [workspaceId, patch.step],
    );
  }
  const sets: string[] = [];
  const values: unknown[] = [workspaceId];
  if (patch.stagedImportId !== undefined) { values.push(patch.stagedImportId); sets.push(`staged_import_id = $${values.length}::uuid`); }
  if (patch.timezone !== undefined) { values.push(patch.timezone); sets.push(`timezone = $${values.length}`); }
  if (patch.mailboxChoice !== undefined) { values.push(patch.mailboxChoice); sets.push(`mailbox_choice = $${values.length}`); }
  if (sets.length > 0) {
    await db.query(`update onboarding_state set ${sets.join(', ')} where workspace_id = $1::uuid`, values);
  }
}

export async function markCalibrationSeen(db: Db, workspaceId: string): Promise<void> {
  await db.query(
    `update onboarding_state set calibration_seen_at = coalesce(calibration_seen_at, now())
     where workspace_id = $1::uuid`,
    [workspaceId],
  );
}

export async function markFirstQueue(db: Db, workspaceId: string): Promise<void> {
  await db.query(
    `update onboarding_state set first_queue_at = coalesce(first_queue_at, now())
     where workspace_id = $1::uuid`,
    [workspaceId],
  );
}

export async function dismissCoachMark(db: Db, workspaceId: string): Promise<void> {
  await db.query(
    `update onboarding_state set coach_dismissed_at = now() where workspace_id = $1::uuid`,
    [workspaceId],
  );
}

// ---------------------------------------------------------------- demo data

export interface DemoOpportunity {
  externalRef: string;
  clientName: string;
  amountCents: number;
  sentDaysAgo: number;
  stage: 'proposal_sent' | 'followup_1' | 'followup_2' | 'followup_3' | 'verbal_yes';
  status: 'open' | 'won' | 'expired';
  arm: 'treatment' | 'holdout';
  touchCount: number;
  replied: boolean;
}

const DEMO_HOLDOUT_INDEXES = new Set([2, 7, 13, 18]);

/** Pure: the seed test asserts on this list before anything touches a database. */
export function demoOpportunities(now: Date = new Date()): DemoOpportunity[] {
  const names = [
    'Cabinet Lefèvre', 'Studio Moreau', 'Bâti+ Conseils', 'Groupe Vasseur',
    'Menuiserie Girard', 'Atlas Immobilier', 'Cabinet Roussel', 'Verger & Fils',
    'Techno-Chartier', 'Hôtel du Parc', 'SCI Beaulieu', 'Renov’Action',
    'Maison Perrin', 'Éclat Communication', 'Transports Duval', 'Cabinet Marchand',
    'Atelier Brault', 'Fermes de Loire', 'Numérique Plus', 'Garonne Négoce',
  ];
  // 20 amounts, every one inside €2 100 – €45 000.
  const amounts = [4_800, 12_500, 2_100, 27_400, 8_900, 15_600, 3_300, 41_200, 6_700, 19_800,
    5_400, 33_100, 2_900, 10_200, 45_000, 7_300, 21_700, 4_100, 16_400, 9_600];
  const sentAgo = [3, 5, 8, 12, 15, 18, 21, 24, 27, 30, 33, 6, 9, 11, 14, 17, 20, 23, 26, 45];
  const stages: DemoOpportunity['stage'][] = [
    'proposal_sent', 'followup_1', 'proposal_sent', 'followup_2', 'proposal_sent',
    'followup_1', 'proposal_sent', 'followup_2', 'followup_1', 'proposal_sent',
    'followup_1', 'proposal_sent', 'followup_2', 'proposal_sent', 'followup_1',
    'proposal_sent', 'followup_1', 'followup_2', 'proposal_sent', 'followup_3',
  ];
  const repliedIdx = new Set([0, 4, 9, 15]);
  const touches = repliedIdx.has(0) ? 1 : 0;

  return names.map((clientName, i) => {
    const arm = DEMO_HOLDOUT_INDEXES.has(i) ? 'holdout' : 'treatment';
    const replied = repliedIdx.has(i);
    const touchCount = i === 0 ? 1 : i === 19 ? 3 : replied ? 0 : Math.min(2, Math.floor(sentAgo[i]! / 10));
    const stage = i === 0 ? 'verbal_yes' : stages[i]!;
    const status = i === 19 ? 'expired' : 'open';
    return {
      externalRef: `demo-${i + 1}`,
      clientName,
      amountCents: amounts[i]! * 100,
      sentDaysAgo: sentAgo[i]!,
      stage,
      status,
      arm,
      touchCount,
      replied,
    } satisfies DemoOpportunity;
  });
}

export interface SeedDemoResult {
  inserted: number;
  holdout: number;
}

/**
 * Seeds exactly 20 realistic French opportunities — 4 holdout, one verbal
 * agreement, one dossier aged beyond the window. Refuses a workspace that
 * holds real data unless `replace` is set: demo and real rows never mix.
 */
export async function seedDemo(
  db: Db,
  workspaceId: string,
  opts: { replace?: boolean; userId?: string | null; now?: Date } = {},
): Promise<SeedDemoResult> {
  const now = opts.now ?? new Date();
  const real = await db.query<{ n: number }>(
    'select count(*)::int as n from opportunities where workspace_id = $1::uuid and source <> \'demo\'',
    [workspaceId],
  );
  const existingReal = real.rows[0]!.n;
  if (existingReal > 0 && !opts.replace) {
    throw new DemoDataConflictError(existingReal);
  }

  await db.exec('begin');
  try {
    if (opts.replace) {
      // Only the demo rows. A downgrade bug must never eat customer data.
      await db.query(
        `delete from opportunities where workspace_id = $1::uuid and source = 'demo'`,
        [workspaceId],
      );
    }

    const rows = demoOpportunities(now);
    let holdout = 0;
    for (const o of rows) {
      if (o.arm === 'holdout') holdout += 1;
      const sentAt = new Date(now.getTime() - o.sentDaysAgo * 24 * 60 * 60 * 1000);
      await db.query(
        `insert into opportunities
           (workspace_id, external_ref, client_name, amount_cents, stage, status,
            sent_at, touch_count, arm, arm_method, source, reply_received_at)
         values ($1::uuid, $2, $3, $4::bigint, $5, $6, $7::timestamptz, $8, $9, 'random', 'demo',
                 $10::timestamptz)
         on conflict (workspace_id, external_ref) where external_ref is not null do nothing`,
        [
          workspaceId, o.externalRef, o.clientName, o.amountCents, o.stage, o.status,
          sentAt.toISOString(), o.touchCount, o.arm,
          o.replied ? new Date(sentAt.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString() : null,
        ],
      );
    }

    await db.query('update workspaces set demo_seeded = true where id = $1::uuid', [workspaceId]);
    await db.query(
      `insert into audit_log (workspace_id, actor_type, actor_user_id, action, entity, entity_id, after)
       values ($1::uuid, 'user', $2::uuid, 'onboarding.demo_seeded', 'workspace', $1::text,
               $3::jsonb)`,
      [workspaceId, opts.userId ?? null, JSON.stringify({ rows: rows.length, replace: opts.replace === true })],
    );
    await db.exec('commit');
    return { inserted: rows.length, holdout };
  } catch (err) {
    await db.exec('rollback');
    throw err;
  }
}

/** The login-screen demo: a workspace of its own, trial status so sending stays sandboxed. */
export async function createDemoWorkspace(db: Db): Promise<{ workspaceId: string; userId: string; email: string }> {
  const email = `demo+${Math.random().toString(36).slice(2, 10)}@rros.demo`;
  const ws = await db.query<{ id: string }>(
    `insert into workspaces (name, slug, plan, subscription_status, trial_ends_at)
     values ('Démo — voir le produit', 'demo-' || substr(md5(random()::text), 1, 10),
             'growth', 'trialing', now() + interval '14 days')
     returning id`,
  );
  const workspaceId = ws.rows[0]!.id;
  const user = await db.query<{ id: string }>(
    `insert into users (auth_user_id, workspace_id, email, full_name, role)
     values ($1, $2::uuid, $3, 'Visiteur démo', 'owner') returning id`,
    [`local:${email}`, workspaceId, email],
  );
    await seedDemo(db, workspaceId, { userId: user.rows[0]!.id });
    await db.query(
      `insert into onboarding_state (workspace_id) values ($1::uuid) on conflict (workspace_id) do nothing`,
      [workspaceId],
    );
    await db.query(
    `update onboarding_state set current_step = 5,
       steps_done = '["account","mailbox","import","calibration"]'::jsonb
     where workspace_id = $1::uuid`,
    [workspaceId],
  );
  return { workspaceId, userId: user.rows[0]!.id, email };
}
