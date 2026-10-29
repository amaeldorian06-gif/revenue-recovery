-- ---------------------------------------------------------------------------
-- 0005 — Phase 05: experiments, snapshots, attribution.
--
-- An experiment is created with the workspace and is never deleted. The holdout
-- has been frozen since phase 02; this table records *when* it started and, if it
-- ever has to be stopped, *why*. A silent restart would look like a good result,
-- which is exactly the thing this product refuses to do.
-- ---------------------------------------------------------------------------

create table experiments (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  kind                text not null default 'holdout' check (kind in ('holdout')),
  rate                numeric(4,3) not null check (rate between 0.100 and 0.300),
  started_at          timestamptz not null,
  ended_at            timestamptz,
  status              text not null default 'running' check (status in ('running','stopped','invalidated')),
  invalidation_reason text,
  created_at          timestamptz not null default now(),
  -- One running experiment per workspace: two holdouts would be two truths.
  constraint experiments_one_running exclude (workspace_id with =) where (status = 'running')
);

create index experiments_workspace_idx on experiments (workspace_id, started_at desc);

alter table experiments enable row level security;
create policy tenant_isolation on experiments
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select on experiments to app_authenticated;

-- ---------------------------------------------------------------------------
-- One row per arm per week. The cohort is the opportunities *sent* in the same
-- trailing window: never month-to-month, never "everything to date".
-- ---------------------------------------------------------------------------
create table snapshots (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  experiment_id   uuid not null references experiments(id) on delete cascade,
  week_start      date not null,
  arm             text not null check (arm in ('treatment','holdout')),
  n_opportunities int not null check (n_opportunities >= 0),
  n_replies       int not null check (n_replies >= 0),
  n_won           int not null check (n_won >= 0),
  revenue_cents   bigint not null check (revenue_cents >= 0),
  n_expired       int not null check (n_expired >= 0),
  computed_at     timestamptz not null default now(),
  unique (experiment_id, week_start, arm)
);

create index snapshots_week_idx on snapshots (workspace_id, week_start desc);

alter table snapshots enable row level security;
create policy tenant_isolation on snapshots
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert, update on snapshots to app_authenticated;

-- ---------------------------------------------------------------------------
-- Precomputed attribution.
--
-- The §5 sketch allowed "snapshot metadata or a dedicated table". Dedicated table:
-- the admin coherence view queries it directly, the results screen reads one row
-- instead of bootstrapping 10 000 resamples per request (criterion 9), and the
-- history of the estimate stays auditable week by week.
-- ---------------------------------------------------------------------------
create table attribution_results (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  experiment_id       uuid not null references experiments(id) on delete cascade,
  week_start          date not null,
  estimate_cents      bigint not null,
  ci_low_cents        bigint not null,
  ci_high_cents       bigint not null,
  relative_effect     numeric(8,4),
  p_value             numeric(6,5) not null check (p_value between 0 and 1),
  significant         boolean not null,
  n_treatment         int not null,
  n_holdout           int not null,
  revenue_b_cents     bigint not null,
  revenue_c_cents     bigint not null,
  required_per_arm    int,
  coherence_verdict   text not null default 'ok' check (coherence_verdict in ('ok','investigate')),
  coherence_gap_cents bigint not null default 0,
  computed_at         timestamptz not null default now(),
  unique (experiment_id, week_start)
);

create index attribution_week_idx on attribution_results (workspace_id, week_start desc);

alter table attribution_results enable row level security;
create policy tenant_isolation on attribution_results
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert, update on attribution_results to app_authenticated;

-- The cohort query filters on sent_at inside a workspace: without this index the
-- weekly job is a scan on every workspace.
create index if not exists opportunities_workspace_sent_idx on opportunities (workspace_id, sent_at);

-- ---------------------------------------------------------------------------
-- Every workspace starts its measurement the moment it exists. Doing it with a
-- trigger rather than in the signup service means the dev seeder, a future API
-- import and a manual SQL insert all get the same guarantee.
-- ---------------------------------------------------------------------------
create or replace function app.start_holdout_experiment() returns trigger
language plpgsql as $$
begin
  insert into experiments (workspace_id, kind, rate, started_at, status)
  values (new.id, 'holdout', new.holdout_rate, coalesce(new.created_at, now()), 'running');
  return new;
end;
$$;

create trigger workspaces_start_experiment
  after insert on workspaces
  for each row execute function app.start_holdout_experiment();

-- Backfill: workspaces created before this migration.
insert into experiments (workspace_id, kind, rate, started_at, status)
select w.id, 'holdout', w.holdout_rate, w.created_at, 'running'
  from workspaces w
 where not exists (select 1 from experiments e where e.workspace_id = w.id and e.status = 'running');
