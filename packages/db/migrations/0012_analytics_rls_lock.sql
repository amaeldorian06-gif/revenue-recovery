-- 0012 — analytics_events : verrou RLS explicite. La table n'a AUCUN grant
-- au rôle applicatif (0011) ; la policy default-deny ci-dessous satisfait en
-- plus l'invariant « toute table à workspace_id porte une policy » testé par
-- rls.test.ts. Le chemin service (asSuperuser) contourne RLS : l'insertion
-- des événements continue de fonctionner ; un rôle applicatif, lui, ne peut
-- ni lire ni écrire quoi que ce soit — par construction et non par oubli.
drop policy if exists analytics_events_deny_all on analytics_events;
create policy analytics_events_deny_all on analytics_events
  for all to app_authenticated
  using (false)
  with check (false);
