-- ---------------------------------------------------------------------------
-- Phase 03 — the daily queue is a table, not a computation.
--
-- Every generation writes what the engine decided, with the version of the
-- formula that decided it. This is what makes the product auditable in six
-- months: "why was this first on 12 March" has an answer stored in a row, even
-- after the weights have been recalibrated twice.
-- ---------------------------------------------------------------------------

create table recommendations (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  opportunity_id       uuid not null references opportunities(id) on delete cascade,
  generated_for        date not null,
  rank                 int not null check (rank between 1 and 100),

  score_cents          bigint not null check (score_cents >= 0),
  expected_value_cents bigint not null check (expected_value_cents >= 0),
  p_reply              numeric(7,6) not null check (p_reply between 0 and 1),
  p_convert            numeric(7,6) not null check (p_convert between 0 and 1),
  urgency              numeric(7,6) not null check (urgency between 0 and 1),
  factors              jsonb not null default '[]'::jsonb,
  engine_version       text not null,

  acted                boolean not null default false,
  acted_at             timestamptz,
  action_kind          text check (action_kind in ('draft_sent','draft_skipped','manual')),

  created_at           timestamptz not null default now(),

  -- One row per dossier per day: regenerating replaces, it does not stack.
  unique (workspace_id, generated_for, opportunity_id)
);
create index recommendations_day_idx on recommendations (workspace_id, generated_for, rank);
create index recommendations_acted_idx on recommendations (workspace_id, acted) where acted;

alter table recommendations enable row level security;
create policy tenant_isolation on recommendations
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

-- DELETE is needed by regeneration, which replaces the day's non-acted rows.
-- The trigger above — not the missing grant — is what protects acted rows.
grant select, insert, update, delete on recommendations to app_authenticated;

-- An acted row is a historical fact: the reason the user saw what they saw.
-- Rewriting or deleting it after the fact would erase the only trace we have.
create or replace function app.reject_acted_rewrite() returns trigger
language plpgsql as $$
begin
  if old.acted and (new.score_cents <> old.score_cents or new.rank <> old.rank) then
    raise exception 'a recommendation already acted on cannot be rewritten';
  end if;
  return new;
end $$;

create trigger recommendations_acted_immutable
  before update on recommendations
  for each row execute function app.reject_acted_rewrite();
