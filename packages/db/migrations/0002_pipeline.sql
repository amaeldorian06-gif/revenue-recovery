-- 0002 — Phase 02: the commercial pipeline.
-- Opportunities, contacts, signals, imports, usage counters.
-- Same tenant model as 0001: workspace_id + RLS on every table.

-- ------------------------------------------------------------------ contacts
create table contacts (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         text not null,
  full_name     text,
  company       text,
  locale        text check (locale in ('fr','en')),
  opt_out_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (workspace_id, email)
);
create index contacts_workspace_idx on contacts (workspace_id);

-- ------------------------------------------------------------- opportunities
-- The decision window is the core domain concept: an unanswered proposal dies.
-- `arm` is frozen at import and must never move (invariant I2).
create table opportunities (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  external_ref      text,
  client_name       text not null check (length(trim(client_name)) > 0),
  contact_id        uuid references contacts(id) on delete set null,
  title             text,
  amount_cents      bigint not null check (amount_cents >= 0),
  currency          char(3) not null default 'EUR',
  stage             text not null default 'proposal_sent'
                    check (stage in ('proposal_sent','followup_1','followup_2',
                                     'followup_3','verbal_yes','negotiation','other')),
  sent_at           timestamptz not null,
  expected_action_at timestamptz,
  owner_user_id     uuid references users(id) on delete set null,

  status            text not null default 'open'
                    check (status in ('open','won','lost','expired','dormant')),
  arm               text not null check (arm in ('treatment','holdout')),
  arm_assigned_at   timestamptz not null default now(),
  arm_method        text not null default 'random' check (arm_method in ('random','imported','manual')),

  touch_count       int not null default 0 check (touch_count between 0 and 3),
  last_touch_at     timestamptz,
  annoyed           boolean not null default false,

  reply_received_at timestamptz,
  closed_at         timestamptz,

  source            text not null default 'import' check (source in ('import','manual','api')),
  raw               jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- An answered proposal can never be "expired": the two states are exclusive.
  constraint no_expired_after_reply
    check (not (status = 'expired' and reply_received_at is not null))
);

create unique index opportunities_workspace_ref_idx
  on opportunities (workspace_id, external_ref) where external_ref is not null;
create index opportunities_workspace_status_idx on opportunities (workspace_id, status, arm);
create index opportunities_workspace_sent_idx on opportunities (workspace_id, sent_at desc);
create index opportunities_workspace_touch_idx on opportunities (workspace_id, last_touch_at desc nulls last);

-- ------------------------------------------------------------- signal_events
create table signal_events (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  opportunity_id uuid not null references opportunities(id) on delete cascade,
  kind           text not null check (kind in ('doc_open','email_open','link_click','reply','note')),
  value          numeric not null default 1,
  occurred_at    timestamptz not null default now(),
  source         text
);
create index signal_events_opp_idx on signal_events (opportunity_id, occurred_at desc);
create index signal_events_ws_idx on signal_events (workspace_id, occurred_at desc);

-- ------------------------------------------------------------------- imports
create table imports (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  uploaded_by    uuid references users(id) on delete set null,
  filename       text not null,
  row_count      int not null default 0,
  imported_count int not null default 0,
  updated_count  int not null default 0,
  skipped_count  int not null default 0,
  mapping        jsonb not null default '{}'::jsonb,
  status         text not null default 'parsed'
                 check (status in ('parsed','mapped','committed','failed')),
  errors         jsonb not null default '[]'::jsonb,
  -- Parsed rows held between the upload step and the mapping step, so a refresh
  -- never loses the uploaded file (phase 02 acceptance criterion 8).
  staged_rows    jsonb,
  headers        jsonb,
  encoding       text,
  created_at     timestamptz not null default now()
);
create index imports_workspace_idx on imports (workspace_id, created_at desc);

-- ------------------------------------------------------------ usage_counters
create table usage_counters (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  period_start      date not null,
  proposals_tracked int not null default 0 check (proposals_tracked >= 0),
  emails_sent       int not null default 0 check (emails_sent >= 0),
  updated_at        timestamptz not null default now(),
  unique (workspace_id, period_start)
);

-- ------------------------------------------------------- row level security
alter table contacts        enable row level security;
alter table opportunities   enable row level security;
alter table signal_events   enable row level security;
alter table imports         enable row level security;
alter table usage_counters  enable row level security;

create policy tenant_isolation on contacts
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on opportunities
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on signal_events
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on imports
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
create policy tenant_isolation on usage_counters
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());

grant select, insert, update, delete
  on contacts, opportunities, signal_events, imports, usage_counters
  to app_authenticated;

-- --------------------------------------------------- arm is immutable in SQL
-- Defence in depth: even a buggy application update cannot move a dossier
-- between the treatment and the holdout arms.
create or replace function app.reject_arm_change() returns trigger
language plpgsql as $$
begin
  if new.arm is distinct from old.arm then
    raise exception 'arm is immutable (invariant I2): % -> %', old.arm, new.arm
      using errcode = 'check_violation';
  end if;
  if new.arm_assigned_at is distinct from old.arm_assigned_at then
    raise exception 'arm_assigned_at is immutable'
      using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger opportunities_arm_immutable
  before update on opportunities
  for each row execute function app.reject_arm_change();
