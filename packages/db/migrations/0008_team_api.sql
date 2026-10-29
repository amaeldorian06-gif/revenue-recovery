-- 0008 — Phase 08: team, public API, webhooks, hardening, observability, GDPR.
-- Every tenant table carries workspace_id + RLS tenant_isolation; the RLS
-- coverage test (criterion 8) loops information_schema and fails on any table
-- that gains a workspace_id without a policy.

-- ------------------------------------------------------------------ api keys
-- Only the SHA-256 hash is stored; `prefix` (first 8 chars) exists to display
-- the key in settings. The plaintext is shown exactly once, at creation.
create table api_keys (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  prefix        text not null,
  key_hash      text not null unique,
  scopes        text[] not null default '{}'
                check (scopes <@ array['read:opportunities','write:actions','read:results']),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index api_keys_workspace_idx on api_keys (workspace_id);

-- ------------------------------------------------------- api request journal
-- Powers the sliding-window rate limit (120 req/min/workspace), the
-- X-RateLimit-Remaining header and the per-route p95 on /admin/ops.
create table api_requests (
  id            bigserial primary key,
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  key_id        uuid references api_keys(id) on delete set null,
  route         text not null,
  status_code   int not null,
  duration_ms   int not null,
  created_at    timestamptz not null default now()
);
create index api_requests_window_idx on api_requests (workspace_id, created_at);

-- ------------------------------------------------------ webhook subscriptions
-- `secret` is the signing key, encrypted at rest with the same AES-256-GCM
-- box as mailbox credentials (we must read it back to sign deliveries).
create table webhook_endpoints (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  url             text not null,
  secret          text not null,
  events          text[] not null default '{}'
                  check (events <@ array['action.sent','reply.received','opportunity.won',
                                         'opportunity.expired','weekly.snapshot','usage.threshold']),
  failure_count   int not null default 0,
  disabled_at     timestamptz,
  disabled_reason text,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index webhook_endpoints_workspace_idx on webhook_endpoints (workspace_id);

create table webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  endpoint_id     uuid not null references webhook_endpoints(id) on delete cascade,
  event           text not null,
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending','succeeded','dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_status_code int,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index webhook_deliveries_due_idx on webhook_deliveries (status, next_attempt_at);
create index webhook_deliveries_workspace_idx on webhook_deliveries (workspace_id, created_at desc);

-- ---------------------------------------------------------------- cron beats
-- One row per job invocation: the health endpoint alerts when a cron has not
-- run within 2× its interval.
create table job_runs (
  id            bigserial primary key,
  job           text not null,
  workspace_id  uuid references workspaces(id) on delete cascade, -- null = global
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running','ok','error')),
  count         int not null default 0,
  error         text
);
create index job_runs_recent_idx on job_runs (job, started_at desc);

-- --------------------------------------------------------------- auth safety
-- Magic links: hashed token, 15-minute expiry, single use. Auth attempts are
-- rate limited per IP (5 / 15 min) — the check reads this table.
create table login_tokens (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  token_hash  text not null unique,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table auth_attempts (
  id          bigserial primary key,
  ip          text not null,
  email       text,
  ok          boolean not null default false,
  created_at  timestamptz not null default now()
);
create index auth_attempts_ip_idx on auth_attempts (ip, created_at);

-- ------------------------------------------------------------- gdpr machinery
create table export_requests (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  requested_by  uuid references users(id) on delete set null,
  status        text not null default 'pending' check (status in ('pending','ready','expired')),
  file_name     text,
  token_hash    text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
create index export_requests_workspace_idx on export_requests (workspace_id);

-- Public API idempotency: a replayed Idempotency-Key returns the stored
-- response instead of creating a second resource.
create table api_idempotency (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  route         text not null,
  idem_key      text not null,
  status_code   int not null,
  response_body jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, route, idem_key)
);

-- ------------------------------------------------------- workspaces lifecycle
alter table workspaces
  add column if not exists deleted_at timestamptz,
  add column if not exists purge_at   timestamptz;

alter table invitations
  add column if not exists invited_by uuid references users(id) on delete set null;

-- ------------------------------------------------------------ row level security
alter table api_keys           enable row level security;
alter table api_requests       enable row level security;
alter table webhook_endpoints  enable row level security;
alter table webhook_deliveries enable row level security;
alter table job_runs           enable row level security;
alter table export_requests    enable row level security;
alter table api_idempotency    enable row level security;

create policy tenant_isolation on api_keys
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on api_requests
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on webhook_endpoints
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on webhook_deliveries
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on job_runs
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on export_requests
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on api_idempotency
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

-- login_tokens and auth_attempts are global (no workspace_id): only the
-- server role touches them, no grant to app_authenticated on purpose.

-- ------------------------------------------------------------- privileges
grant select, insert, update, delete on
  api_keys, webhook_endpoints, webhook_deliveries, export_requests, api_idempotency
  to app_authenticated;
grant select, insert, update on api_requests to app_authenticated;
grant select, insert, update on job_runs to app_authenticated;
