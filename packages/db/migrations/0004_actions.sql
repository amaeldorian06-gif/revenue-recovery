-- ---------------------------------------------------------------------------
-- Phase 04 — actions: the outbox and its event log in one table.
--
-- Master prompt §5 models `actions` as a lifecycle log (kind = draft_generated,
-- approved, sent, …). A full cycle therefore leaves exactly three rows for one
-- dossier: the draft the model proposed, the version the human approved, and the
-- send. Keeping all three is what makes the edit ratio and the audit trail
-- computable after the fact — overwriting a single row would destroy the draft.
-- ---------------------------------------------------------------------------

create table actions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  opportunity_id    uuid not null references opportunities(id) on delete cascade,
  recommendation_id uuid references recommendations(id) on delete set null,
  parent_action_id  uuid references actions(id) on delete set null,

  kind              text not null check (kind in (
                      'draft_generated','approved','sent','deferred','dismissed',
                      'cancelled')),
  status            text not null check (status in (
                      'draft','approved','sending','sent','failed','cancelled',
                      'deferred','dismissed')),

  actor_type        text not null default 'system' check (actor_type in ('system','user')),
  actor_user_id     uuid references users(id) on delete set null,
  channel           text not null default 'email' check (channel in ('email','phone','other')),

  tone              text check (tone in ('warm','direct','formal')),
  subject           text,
  draft_text        text,
  final_text        text,
  rationale         text,
  edit_ratio        numeric(5,4) check (edit_ratio is null or edit_ratio between 0 and 1),

  model             text,
  prompt_version    text not null default 'v1',
  violation_codes   text[] not null default '{}',

  scheduled_for     timestamptz,
  sent_at           timestamptz,
  provider          text,
  provider_message_id text,
  sandbox           boolean not null default false,
  error_code        text,
  error_message     text,
  retry_count       int not null default 0 check (retry_count between 0 and 2),
  dismissed_reason  text check (dismissed_reason in (
                      'not_relevant','already_answered_elsewhere','client_asked_to_stop','other')),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index actions_workspace_status_idx on actions (workspace_id, status);
create index actions_opportunity_idx on actions (opportunity_id, created_at desc);
create index actions_due_idx on actions (workspace_id, scheduled_for)
  where kind = 'approved' and status = 'approved';
-- One live draft per opportunity: regenerating replaces, it does not stack.
create unique index actions_one_live_draft on actions (opportunity_id)
  where kind = 'draft_generated' and status = 'draft';
-- One human approval per draft.
create unique index actions_one_approval on actions (parent_action_id)
  where kind = 'approved';

alter table actions enable row level security;
create policy tenant_isolation on actions
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert, update on actions to app_authenticated;

-- ---------------------------------------------------------------------------
-- Every send attempt, whether it succeeded or not. The unique (action, attempt)
-- pair is what makes a retried job unable to send the same message twice.
-- ---------------------------------------------------------------------------
create table send_attempts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  action_id           uuid not null references actions(id) on delete cascade,
  attempt             int not null check (attempt >= 1),
  provider            text not null,
  idempotency_key     text not null,
  provider_message_id text,
  ok                  boolean not null,
  error_code          text,
  error_message       text,
  sandbox             boolean not null default false,
  created_at          timestamptz not null default now(),
  unique (action_id, attempt)
);
create index send_attempts_ws_idx on send_attempts (workspace_id, created_at desc);

alter table send_attempts enable row level security;
create policy tenant_isolation on send_attempts
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert on send_attempts to app_authenticated;

-- The user-editable free text that feeds the prompt (§8.1 `context_note`).
alter table opportunities add column context_note text;
