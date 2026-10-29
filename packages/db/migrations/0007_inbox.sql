-- 0007 — Phase 07: inbox sync, reply detection, privacy and retention.
-- The loop closer: a client who answers stops the sequence without anyone
-- touching the tool. Bodies are opt-in; snippets and headers are the default.

-- ------------------------------------------------------ mailbox connections
alter table mailbox_connections
  add column if not exists email_address      text,
  add column if not exists credentials_encrypted text,          -- secretBox v1:…
  add column if not exists sync_cursor        text,               -- historyId / UID
  add column if not exists last_sync_at       timestamptz,
  add column if not exists last_error         text,
  add column if not exists last_error_at      timestamptz,
  add column if not exists revoked_at         timestamptz;

-- ------------------------------------------------------------- mail_messages
-- One row per message we actually saw. Bodies only exist when the workspace
-- opted in; the snippet is always ≤ 1 000 chars.
create table mail_messages (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  mailbox_id     uuid not null references mailbox_connections(id) on delete cascade,
  opportunity_id uuid references opportunities(id) on delete set null,
  direction      text not null check (direction in ('in','out')),
  provider_id    text not null,
  thread_id      text,
  from_email     text not null,
  to_emails      jsonb not null default '[]'::jsonb,
  cc_emails      jsonb not null default '[]'::jsonb,
  subject        text not null default '',
  snippet        text not null default '',
  body           text,
  headers        jsonb not null default '{}'::jsonb,
  sent_at        timestamptz not null,
  is_bounce      boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (mailbox_id, provider_id)
);
create index mail_messages_ws_idx on mail_messages (workspace_id, sent_at desc);
create index mail_messages_opp_idx on mail_messages (opportunity_id, sent_at desc);
alter table mail_messages enable row level security;
create policy tenant_isolation on mail_messages
  using (workspace_id = app.current_workspace_id())
  with check (workspace_id = app.current_workspace_id());
grant select, insert, update, delete on mail_messages to app_authenticated;

-- Contacts remember bounces: a dead address never receives again.
alter table contacts add column if not exists bounced_at timestamptz;

-- A reply detected by the sync leaves an action-shaped trace, like every other
-- thing that happened to a dossier.
alter table actions drop constraint actions_kind_check;
alter table actions add constraint actions_kind_check check (kind in (
  'draft_generated','approved','sent','deferred','dismissed','cancelled',
  'reply_detected'));
alter table actions drop constraint actions_status_check;
alter table actions add constraint actions_status_check check (status in (
  'draft','approved','sending','sent','failed','cancelled','deferred','dismissed',
  'done'));

-- Purge logging keeps counts, never contents.
grant execute on function pg_catalog.now() to app_authenticated;
