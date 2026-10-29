-- 0011 — Analytics d'acquisition (additif). Mesure d'entonnoir SANS donnée
-- financière : un événement nommé, une page, une locale, un identifiant
-- anonyme (cookie sans PII) et — seulement quand une session existe — le
-- workspace, pour relier activation et compte. Jamais de montant, de nom de
-- client ou de contenu de facture dans ces événements (règle du master
-- prompt §12).
create table if not exists analytics_events (
  id            bigserial primary key,
  name          text not null,
  path          text not null default '',
  locale        text not null default 'fr',
  anonymous_id  text,
  workspace_id  uuid references workspaces(id) on delete set null,
  props         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists analytics_events_name_idx on analytics_events (name, created_at desc);
create index if not exists analytics_events_workspace_idx on analytics_events (workspace_id, created_at desc);

-- Table de télémétrie interne : aucun accès au rôle applicatif (lecture comme
-- écriture passent par le chemin service). Rien n'est exposé via PostgREST
-- ou une API de lecture : agrégations futures uniquement côté service.
alter table analytics_events enable row level security;
