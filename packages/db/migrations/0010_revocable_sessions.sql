-- 0010 — Sessions révocables (additif). Un JWT reste vérifiable offline, mais
-- la révocation est un fait serveur : la table fait foi, le cookie seul ne
-- suffit plus. Aucune colonne existante n'est touchée.
create table if not exists sessions (
  id              uuid primary key,
  user_id         uuid not null references users(id) on delete cascade,
  workspace_id    uuid not null references workspaces(id) on delete cascade,
  role            text not null,
  email           text not null,
  locale          text not null default 'fr',
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_reason  text
);

create index if not exists sessions_user_idx on sessions (user_id);
create index if not exists sessions_workspace_idx on sessions (workspace_id);

-- Lecture louable au rôle applicatif (future UI « mes sessions actives ») :
-- cloisonnée par workspace comme partout, RLS obligatoire. L'INSERT/UPDATE
-- (création, révocation) reste réservé au chemin service (asAdmin) :
-- aucun grant d'écriture n'est donné au rôle applicatif.
alter table sessions enable row level security;

drop policy if exists sessions_workspace_read on sessions;
create policy sessions_workspace_read on sessions
  for select to app_authenticated
  using (workspace_id = app.current_workspace_id());

grant select on sessions to app_authenticated;
