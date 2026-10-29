-- 0001 — Phase 01 foundation: workspaces, users, invitations, audit log.
-- Every tenant table carries workspace_id and is protected by RLS using the
-- JWT claim, identical to the Supabase production setup.

-- gen_random_uuid() is built into Postgres 13+. Hashing (tokens, keys) happens in
-- Node crypto, not in the database, so pgcrypto is not required.

-- ---------------------------------------------------------------- workspaces
create table workspaces (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null check (length(trim(name)) between 1 and 120),
  slug                  text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,60}[a-z0-9])$'),
  plan                  text not null default 'growth' check (plan in ('starter','growth','scale')),
  stripe_customer_id    text unique,
  stripe_subscription_id text unique,
  subscription_status   text not null default 'trialing'
                        check (subscription_status in ('trialing','active','past_due','canceled','incomplete')),
  trial_ends_at         timestamptz,
  timezone              text not null default 'Europe/Paris',
  locale                text not null default 'fr' check (locale in ('fr','en')),
  holdout_rate          numeric(4,3) not null default 0.200 check (holdout_rate between 0.100 and 0.300),
  daily_capacity        int not null default 8 check (daily_capacity between 4 and 20),
  scoring_config        jsonb not null default '{}'::jsonb,
  demo_seeded           boolean not null default false,
  store_body            boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

-- --------------------------------------------------------------------- users
create table users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  text not null unique,          -- Supabase auth uid
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  full_name     text,
  role          text not null default 'member'
                check (role in ('owner','admin','member','viewer')),
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, email)
);
create index users_workspace_idx on users (workspace_id);

-- A workspace has exactly one owner. Enforced by a partial unique index.
create unique index users_single_owner_idx on users (workspace_id) where role = 'owner';

-- --------------------------------------------------------------- invitations
create table invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  role          text not null check (role in ('admin','member','viewer')),
  token_hash    text not null unique,
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index invitations_workspace_idx on invitations (workspace_id);

-- ----------------------------------------------------------------- audit_log
-- Append-only. No UPDATE or DELETE grant is ever issued to the application role.
create table audit_log (
  id            bigserial primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  actor_type    text not null check (actor_type in ('system','user')),
  actor_user_id uuid,
  action        text not null,
  entity        text not null,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  ip            inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index audit_log_workspace_idx on audit_log (workspace_id, created_at desc);

-- ------------------------------------------------------- row level security
alter table workspaces  enable row level security;
alter table users       enable row level security;
alter table invitations enable row level security;
alter table audit_log   enable row level security;

create schema if not exists app;

-- Helper: current workspace from the JWT claim. STABLE so it is evaluated once
-- per statement rather than once per row.
create or replace function app.current_workspace_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'workspace_id', '')::uuid
$$;

create policy tenant_isolation on workspaces
  using (id = app.current_workspace_id())
  with check (id = app.current_workspace_id());

create policy tenant_isolation on users
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

create policy tenant_isolation on invitations
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

create policy tenant_isolation on audit_log
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

-- ------------------------------------------------------------- privileges
grant usage on schema app, auth, public to app_authenticated;
grant select, insert, update, delete on workspaces, users, invitations to app_authenticated;
grant select, insert on audit_log to app_authenticated;
grant usage, select on sequence audit_log_id_seq to app_authenticated;

-- Append-only enforcement at the grant level, not by convention.
revoke update, delete on audit_log from app_authenticated;
revoke update, delete on audit_log from public;
