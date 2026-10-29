-- 0006 — Phase 06: billing, entitlements metering, onboarding state, funnel.
-- Stripe never talks to the database directly: every mutation goes through the
-- webhook handler, which is idempotent thanks to stripe_events.

-- ------------------------------------------------------------ stripe_events
-- One row per event id. The handler's first statement is an insert … on
-- conflict do nothing: if the row already exists the event is a replay and is
-- acknowledged with 200 without touching state again.
create table stripe_events (
  id          text primary key,
  type        text not null,
  payload     jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now()
);
alter table stripe_events enable row level security;
-- Internal table: no tenant policy on purpose, only the service role touches it.
revoke all on stripe_events from app_authenticated;

-- ------------------------------------------------------ billing columns
-- past_due_at: when the first failed invoice was seen. The state machine needs
-- it to distinguish "day 1, sending paused but readable" from "day 4, frozen".
alter table workspaces
  add column if not exists past_due_at         timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists current_period_end  timestamptz,
  add column if not exists billing_interval    text not null default 'monthly'
                                               check (billing_interval in ('monthly','annual'));

-- ------------------------------------------------------ mailbox_connections
-- Minimal in phase 06 (counted for the connect_mailbox entitlement); phase 07
-- extends it with sync cursors and encrypted tokens.
create table mailbox_connections (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  provider     text not null check (provider in ('gmail_oauth','smtp_imap','sandbox')),
  status       text not null default 'connected' check (status in ('connected','pending','disconnected')),
  created_at   timestamptz not null default now(),
  unique (workspace_id, provider)
);
alter table mailbox_connections enable row level security;
create policy tenant_isolation on mailbox_connections
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert, update, delete on mailbox_connections to app_authenticated;

-- ------------------------------------------------------ onboarding_state
-- Server-side wizard state: a refresh, a closed tab, a different browser on the
-- same account must all land back on the exact same step.
create table onboarding_state (
  workspace_id        uuid primary key references workspaces(id) on delete cascade,
  current_step        int  not null default 1 check (current_step between 1 and 5),
  steps_done          jsonb not null default '[]'::jsonb,
  staged_import_id    uuid,
  timezone            text,
  mailbox_choice      text check (mailbox_choice in ('gmail','smtp_imap','later')),
  demo_data           boolean not null default false,
  signup_completed_at timestamptz,
  calibration_seen_at timestamptz,
  first_queue_at      timestamptz,
  coach_dismissed_at  timestamptz,
  updated_at          timestamptz not null default now()
);
alter table onboarding_state enable row level security;
create policy tenant_isolation on onboarding_state
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert, update, delete on onboarding_state to app_authenticated;

-- ------------------------------------------------------ funnel_events
-- signup_completed → queue_generated. The funnel is how we know where the
-- 8-minute promise dies; it is internal, like the coherence view.
create table funnel_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid references users(id) on delete set null,
  name         text not null,
  created_at   timestamptz not null default now(),
  unique (workspace_id, name)
);
create index funnel_events_name_idx on funnel_events (name, created_at);
alter table funnel_events enable row level security;
create policy tenant_isolation on funnel_events
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert on funnel_events to app_authenticated;

-- Demo opportunities are distinguishable from real imports, so "replace the
-- demo data" can delete exactly the demo rows and nothing else.
alter table opportunities drop constraint opportunities_source_check;
alter table opportunities add constraint opportunities_source_check
  check (source in ('import','manual','api','demo'));

grant select, insert, update, delete on usage_counters to app_authenticated;
