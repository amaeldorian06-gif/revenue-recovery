# RAPPORT_SECURITE — Validation PostgreSQL réel (multi-connexions) & sessions révocables

Les deux chantiers demandés, exécutés l'un après l'autre, **prouvés par
exécution** (jamais par affirmation). Date : 2026-10-29.

---

## Tâche ① — La suite tourne sur un PostgreSQL RÉEL multi-connexions

### Pourquoi c'était le trou n° 1
Tout tournait sur PGlite (une seule connexion, en mémoire). Les garanties
RLS « par connexion », les verrous de ligne et la concurrence réelle — la
topologie exacte de Supabase — étaient **structurellement invérifiables**.

### Ce qui a été construit
- `Db` devient une **interface** (query + exec) ; PGlite reste le driver par
  défaut. `RROS_DB_DRIVER=pg` + `DATABASE_URL` bascule sur un vrai serveur.
- **Adaptateur pg** : handle partagé = une connexion dédiée (begin/commit
  identiques à PGlite) ; `asWorkspace`/`asSuperuser` empruntent une
  **connexion dédiée par bloc** (pool de 8) : rôle locataire et claims JWT
  vivent sur CETTE connexion, routage des requêtes par AsyncLocalStorage.
- **Cluster réel local** : `tools/pg_local.sh` — binaires PostgreSQL natifs
  (paquet `@embedded-postgres`), initdb + base `rros` ; le serveur tourne en
  process de fond (port 5433). Aucun root requis.
- **`pg_multi.test.ts`** (pg uniquement, sauté sur PGlite) : clients bruts
  sur connexions distinctes, sans filet.

### Preuves exécutées
| Vérification | Résultat |
|---|---|
| Suite complète sur **PGlite** | **568 PASS + 4 skips driver-gated** |
| Suite complète sur **PostgreSQL réel** (51 fichiers) | **572/572 PASS** |
| RLS isole deux locataires sur deux connexions distinctes | PASS (0 ligne traversante, UPDATE croisé = no-op) |
| Les grants lient le rôle RÉEL (pas d'UPDATE subscriptions/payments/users.is_platform_admin, pas de DELETE audit) | PASS (`permission denied`) |
| `FOR UPDATE` **bloque entre connexions** : une confirmation attend un verrou manuel, observe le rollback puis active | PASS (**attente de 300 ms observée**, puis gain) |
| Deux confirmations concurrentes → exactement un mois | PASS |
| Migrations 0000→0010 sur le vrai moteur | PASS (idempotence incluse) |
| Perf 5 000 dossiers sur le vrai moteur | p95 **93 ms** (< 400 ms) |

### Deux découvertes du vrai moteur (corrégées)
1. **Donnée invalide masquée** : le test de perf insérait des entiers dans une
   colonne `timestamptz` — PGlite tolérait, PostgreSQL a refusé à juste titre.
   Données corrigées (offsets en jours → timestamps ISO).
2. **Statistiques après chargement massif** : sans `ANALYZE`, le planner réel
   basculait sur des plans catastrophiques (p95 1834 ms). Le flux d'import
   réel fait déjà l'ANALYZE ; le test simule désormais l'état post-import →
   p95 **93 ms**.

### Ce qui reste pour Supabase
Le service managé = changer `DATABASE_URL` + re-jouer la même suite dessus
(les binaires locaux sont PostgreSQL 18 ; Supabase 15 — le SQL du produit est
standard, aucune fonction spécifique 18). Aucune donnée réelle à migrer à ce
stade.

---

## Tâche ② — Sessions révocables : la ligne dépasse le cookie

### Pourquoi c'était le trou n° 2
Le JWT était stateless 7 jours : un cookie volé vivait jusqu'à expiration,
la déconnexion ne faisait que vider le navigateur. L'admin plateforme — qui
confirme les paiements — n'avait aucune corde de secours.

### Ce qui a été construit
- **Migration 0010** (additive) : table `sessions` (sid, user, workspace,
  rôle, email, locale, created_at, last_seen_at, expires_at, revoked_at,
  revoked_reason). RLS workspace-scopée en SELECT pour le rôle applicatif,
  **aucun grant d'écriture** — la révocation est un acte du chemin service.
- **`mintSession`** (lib/session.ts) : le SEUL émetteur — rotation (une
  nouvelle session **révoque le sid précédent**), insertion de la ligne,
  signature du JWT qui porte le sid. `createSession` (cookie) et la route
  dev team passent tous deux par là : **aucun token ne peut exister sans sa
  ligne révocable**.
- **`getSession`** : signature vérifiée **ET** ligne lue en base à CHAQUE
  requête — révoquée, expirée ou sans sid (cookie pré-0010, falsifié) →
  refusée. Le soft-delete du workspace coupe aussi (inchangé).
- **Signout** : révocation serveur d'abord, destruction du cookie ensuite.
- **Cron retention** : purge des lignes expirées depuis > 30 jours
  (`sessionsPurged` dans la réponse du job).
- **`tools/session_revocation_check.mjs`** : la preuve par le vrai UI.

### Preuves exécutées
| Vérification | Résultat |
|---|---|
| Tests unitaires sessions (prédicat de vie, révocation idempotente à raison unique, cookie sans ligne = mort) | **4/4** |
| RLS sessions : le locataire lit les siennes seulement, ne peut NI insérer NI révoquer NI supprimer | PASS (`permission denied`) |
| **Preuve live 6/6** : signup réel → cookie volé rejoué depuis un 2ᵉ navigateur = accepté (le risque visé) → déconnexion UI réelle → **le même cookie volé est REFUSÉ** → la victime est dehors aussi | **6/6** |
| Suite complète PGlite | 568 PASS |
| Suite complète PostgreSQL réel | 572/572 |
| Flows HTTP (matrix 10/10, licensing 14/14) + parcours navigateur (walk_gate 6/6) | VERTS |
| `tsc -p apps/web` (réf. CI) + build production | 0 erreur / OK |

### Deux vrais bugs trouvés par la preuve live (corrégés)
1. **Boucle de redirection infinie** pour tout porteur d'un cookie mort :
   le middleware renvoyait /login → /fr sur simple PRÉSENCE du cookie pendant
   que le layout renvoyait /fr → /login sur session invalide. Corrigé : le
   middleware ne juge plus (il ne le peut pas — la validité est un fait de
   base) ; les pages login/signup vérifient `getSession()` elles-mêmes.
2. **Tokens sans sid** : la route dev team frappait des JWT bruts en
   court-circuitant la couche session — refusés à juste titre par la nouvelle
   exigence (401 sur la matrice de permissions). Corrigé via `mintSession`.

---

## État final

PGlite : **568 PASS** (+4 skips pg-only) · PostgreSQL réel : **572/572** ·
`tsc` 0 · build OK · flow_licensing **14/14** · flow_matrix **10/10** ·
revocation_check **6/6** · walk_gate **6/6** · serveur de production sain.

## Ce que ces chantiers NE couvrent pas (toujours ouvert)

2FA sur les comptes plateforme, alerting Sentry réel (DSN), TLS/WAF de
l'hébergeur, vault de secrets + rotation exécutée, sauvegarde/restauration
exercée sur la cible managée, revue juridique RGPD. Le rejeu sur l'instance
Supabase elle-même (une fois les credentials disponibles) reste la dernière
étape de la tâche ① — le chemin est maintenant une commande, pas un chantier.
