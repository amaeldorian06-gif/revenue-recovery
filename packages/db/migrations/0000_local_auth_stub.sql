-- LOCAL / TEST ONLY. Supabase provides auth.jwt() natively; this stub lets the
-- exact same policies run against an embedded Postgres (PGlite) in CI.
create schema if not exists auth;

create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- Application role. Deliberately NOLOGIN and NOT a superuser: RLS is bypassed
-- by superusers and table owners, so tests must SET ROLE before querying.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_authenticated') then
    create role app_authenticated nologin noinherit;
  end if;
end $$;
