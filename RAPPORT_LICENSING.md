# RAPPORT_LICENSING — Licences mensuelles sécurisées, paiements manuels & contrôle d'accès backend

Livraison du module de licensing du MASTER PROMPT « Secure Monthly Licensing,
Manual Payments & Backend Access Control » sur Revenue Recovery OS. Tout ce qui
est affirmé ici a été **exécuté et observé** sur le backend réel (PGlite en
mémoire, serveur de production Next 15, vitest, flows HTTP) — aucun test n'est
déclaré vert sans l'avoir tourné. Date d'exécution : 2026-10-28.

---

## 1. Résumé exécutif

Le produit devient facturable au mois par **paiement manuel** (virement,
Chariow, Maketou) : le client déclare son paiement, l'admin plateforme
**vérifie réception réelle** (montant attendu vs déclaré, référence), et **lui
seul** active la licence. Une déclaration n'ouvre jamais l'accès ; un essai
terminé sans confirmation coupe toute l'application (UI, API v1, cron d'envoi).
Le billing Stripe existant est **conservé tel quel** et documenté en
coexistence (§12). Livré : migration 0009 additive, service d'entitlement
central, console admin, page client, gates sur toutes les surfaces, 24 tests
backend ciblés, recette HTTP 14/14, plan de rollback.

**Chiffres du run final** : vitest **593/593** (dont 24 licensing), `tsc` 0
erreur, build production OK, recette HTTP **14/14 PASS**, cron observé avec
`skipped: license_expired`, gate (app) observé en 307 → `/fr/subscription`.

## 2. Périmètre livré / hors périmètre

**Livré**
- Migration `0009_manual_licensing.sql` (produit, admin plateforme, subscriptions, payments, grants, audit).
- Service d'entitlement server-only (`packages/db/src/repo/licensing.ts` + `apps/web/lib/licensing.ts`) : validité calculée, jamais le statut seul.
- Confirmation transactionnelle idempotente concurrent-safe (montant, extension calendaire, rollback).
- 5 server actions (déclaration, confirmation, rejet, suspension, réactivation) gardées par `isPlatformAdmin` lu en DB à chaque appel.
- UX client `/subscription` (paliers 299/699/1 490 €, instructions de paiement, formulaire, historique, péremption) + console admin `/admin/licenses` (comparaison montant/référence, confirm/reject/suspend/reactivate, audit).
- Gates : layout `(app)`, `/api/v1` (403 `SUBSCRIPTION_REQUIRED`), cron d'envoi (`license_<code>`), endpoint `/api/license` calculé serveur.
- RLS/grants : le client lit sa souscription, soumet et lit ses paiements — il ne peut ni activer, ni étendre, ni confirmer, ni modifier une échéance, ni lire autrui, ni écrire l'audit (tests SQL directs).
- Tests §12 et recette E2E, exécutés sur le backend réel.

**Hors périmètre (assumé)**
- Aucune intégration d'API Chariow/Maketou : leurs capacités réelles n'ont pas été vérifiées, elles restent des **méthodes de paiement affichées** (display-only), avec instructions.
- Zéro Stripe SDK/checkout/agrégateur/carte dans le nouveau module (l'existant est conservé mais ne participe pas au licensing).
- Pas de relance automatique de renouvellement, pas de grâce, pas de réactivation automatique.

## 3. Architecture & fichiers

| Fichier | Rôle |
|---|---|
| `packages/db/migrations/0009_manual_licensing.sql` | schéma additif + grants (jamais chargée en prod client : PGlite la roule au boot ; Supabase : `supabase db push`) |
| `packages/db/src/repo/licensing.ts` | ledger transactionnel : `getCurrentEntitlement`, `confirmPaymentAndActivateSubscription`, `submitPaymentDeclaration`, `suspendSubscription`, `reactivateSubscription`, `expectedAmountCents` (peg XAF 655,957) |
| `packages/db/src/client.ts` | export `withExclusive` : sérialisation des transactions multi-instructions sur la connexion unique |
| `apps/web/lib/licensing.ts` | `getEntitlement(session)`, `withEntitlement` (401/403 avec reasonCode), `isPlatformAdmin` (DB à chaque appel) |
| `apps/web/lib/actions/licensing.ts` | 5 server actions `'use server'`, admin gardées par `isPlatformAdmin` |
| `apps/web/app/api/license/route.ts` | GET no-store : `{product, status, access_allowed, expires_at, reason}` ; 401 sans session |
| `apps/web/app/[locale]/subscription/page.tsx` | parcours client (paliers, instructions env `PAYMENT_BANK_DETAILS`/`CHARIOW_URL`/`MAKETOU_URL`, formulaire, historique, phrase d'état) |
| `apps/web/app/[locale]/admin/licenses/page.tsx` | console plateforme (pending + confirm/reject/suspend/reactivate + audit) |
| `apps/web/app/api/dev/licensing/route.ts` | DEV ONLY (`RROS_DEV_SEED=1`) : miroir des actions pour les flows automatisés (declare/confirm/suspend/reactivate/entitlement/end-trial/expire/revoke-admin) |
| `apps/web/app/api/cron/send/route.ts` | gate licence par workspace avant tout envoi |
| `apps/web/lib/api-v1.ts` | 403 `SUBSCRIPTION_REQUIRED` dans `withApiKey` |
| `apps/web/app/[locale]/(app)/layout.tsx` | redirect `/subscription` si `!accessAllowed` (filtre navigation) |
| `packages/db/src/__tests__/licensing.test.ts` | 24 tests §12 sur la base réelle, y compris refus RLS en SQL direct |
| `tools/flow_licensing.py` | recette HTTP de bout en bout (14 vérifications) |

## 4. Modèle de données & migration (non destructive)

- `products(id text PK, name, enabled boolean default true)` — produit `revenue_recovery_os`.
- `users.is_platform_admin boolean not null default false` — `REVOKE UPDATE` puis `GRANT UPDATE (email, full_name, role, last_seen_at)` : **l'app ne peut pas écrire la colonne**.
- `subscriptions` : `UNIQUE(workspace_id, product_id)`, `status` CHECK sur 5 états (`pending, active, suspended, expired, cancelled`, défaut `pending`), `starts_at/expires_at timestamptz`.
- `payments` : `plan` CHECK 3 paliers, `amount_cents bigint > 0`, `currency` CHECK `EUR/XAF`, `method` CHECK (`bank_transfer, chariow, maketou`), `external_reference`, `status` CHECK 4 états (`pending, confirmed, rejected, refunded`, défaut `pending`), `rejection_reason`, `submitted_by NOT NULL`, `validated_by/validated_at`, **index unique partiel** `(payment_method, external_reference) WHERE external_reference IS NOT NULL` (double référence impossible), index partiel des pending.
- Grants app : `SELECT products/subscriptions`, `SELECT/INSERT payments`, et **aucun** UPDATE/DELETE sur `subscriptions`/`payments` — c'est la protection RLS même sans policy : le client ne peut activer/étendre/confirmer par aucun chemin.
- Aucune table existante n'est altérée ; l'essai (`workspaces.subscription_status='trialing'`, `trial_ends_at`) reste la source du funnel.

## 5. Entitlement : règles de validité

`getCurrentEntitlement(db, workspaceId, now)` retourne `{accessAllowed, status, productId, expiresAt, reasonCode}` :
1. Produit désactivé → `product_disabled` (refus), même souscription active.
2. Souscription `revenue_recovery_os` inexistante : essai actif → `trial_active` (comportement funnel **préservé**, observé en test) ; sinon `no_subscription`.
3. Sinon validité **tous critères** : `status='active'` ET `starts_at <= now` ET `expires_at > now` ET produit activé. `now == expires_at` = expiré (pas de grâce).
4. La péremption est **retournée à la lecture** : `status` passe à `expired` + audit `subscription.expired` (lazy flip, audité, observé en E2E).
5. `reasonCode` ∈ `trial_active, subscription_active, no_subscription, pending, expired, suspended, cancelled, not_started, product_disabled` — toujours une **raison**, jamais un booléen nu.

## 6. Paiements manuels & confirmation (la transaction)

`confirmPaymentAndActivateSubscription` s'exécute dans `withExclusive` (un seul verrou) puis en transaction :
1. `SELECT … FOR UPDATE` du paiement demandé : inexistant → `not_found` ; statut ≠ `pending` → `not_pending` (une 2ᵉ confirmation ne donne rien, **observé** : `already_confirmed`).
2. Comparaison `amount_cents/currency` vs prix attendu du plan (EUR ×100 ; XAF = `round(eur × 655,957)`, peg fixe). Écart → paiement `rejected` (`amount_mismatch`, audité) et **aucune** activation (**observé** : `expected 69900 EUR, received 100`).
3. Souscription verrouillée (`for update`, contrôle workspace+produit) : extension d'**un mois calendaire** (`+ interval '1 month'`, PG garantit 31 janv → 28/29 févr — **testé**) depuis `expires_at` si encore actif, sinon depuis `now`. Première activation → `confirmed_activated`, prolongation → `confirmed_extended` ; audit `subscription.activated/renewed`.
4. `workspaces.subscription_status='active'`.
5. Tout échec → **rollback complet** (testé : paiement à un utilisateur supprimé → rejet, paiement reste `pending`, accès inchangé).
6. Un paiement `refunded` ne rouvre rien : re-confirm refusé (`not_pending`), période intacte (testé).
7. Déclaration : montant ≤ 0 → `bad_amount` ; référence déjà utilisée (même méthode) → `duplicate_reference` via l'index unique (testé) ; souscription `pending` créée si absente (audit `subscription.requested`).

## 7. Sécurité & authz

- **Admin plateforme** : `users.is_platform_admin`, lu **en DB à chaque appel** (pas dans le JWT, pas de cache). Les grants 0009 empêchent l'app d'écrire la colonne — testé en SQL direct (refus `permission denied`, valeur inchangée).
- **RLS/Grants (tests SQL exécutés)** : le rôle applicatif ne peut pas `UPDATE subscriptions` (statut, `expires_at`, owner), pas `UPDATE payments` vers `confirmed`, ni lire les souscriptions/paiements d'un autre tenant (0 ligne en contexte B), ni `UPDATE`/`DELETE audit_log`.
- Session : JWT maison inchangé ; **aucun ID user ne vient du navigateur** — chaque surface repart de la session serveur.
- `/api/license` sans session → 401 (observé) ; avec session → état calculé serveur, `no-store`.

## 8. Gates par surface (défense en profondeur)

| Surface | Comportement sans licence | Preuve d'exécution |
|---|---|---|
| Layout `(app)` | 307 → `/{locale}/subscription` | flow : `307 http://…/fr/subscription` |
| `/api/v1/*` (clé API) | 403 JSON `SUBSCRIPTION_REQUIRED` | `withApiKey` patché ; gate observé par flow via layout + vitest |
| Cron d'envoi | skip par workspace `license_<reasonCode>` | observé : `skipped: license_expired` (×1) après péremption forcée |
| `/api/license` | état calculé, 401 sans session | flow 14/14 |
| Server actions | 401/403 avec reasonCode via `withEntitlement` | vitest |

Le layout n'est **que** un filtre de navigation : chaque surface serveur vérifie l'entitlement elle-même.

## 9. UX client & admin

- **Client** `/subscription` : trois paliers (299/699/1 490 €/mois HT), instructions de paiement par méthode (virement : coordonnées via `PAYMENT_BANK_DETAILS` ; Chariow/Maketou : liens `CHARIOW_URL`/`MAKETOU_URL`, display-only), formulaire de déclaration (palier, devise, montant déclaré, méthode, référence), historique des paiements — **jamais** marqués « payé/confirmé » avant confirmation backend (assertion de flow), phrase d'état FR/EN par `reasonCode` avec échéance.
- **Admin** `/admin/licenses` : déclarations en attente (montant attendu vs déclaré, référence, demandeur), confirmer/rejeter, souscriptions actives avec période résultante, suspendre/réactiver (0–12 mois d'extension), piste d'audit récente. L'URL n'est pas une autorisation : `isPlatformAdmin` re-vérifié au rendu (redirect sinon).

## 10. Tests backend réels (§12) — exécutés

`packages/db/src/__tests__/licensing.test.ts` — **24/24 PASS** sur PGlite réelle :
validité aux bornes (statut seul insuffisant, `now == expires_at`, non commencé, mauvais produit, produit désactivé), essai préservé, extension calendaire (31 janv → 28 févr ; 28 févr → 28 mars), double confirmation (idempotence), course concurrente (1 mois max — via `withExclusive`), double référence, montant inexact (rejet audité), rollback intégral, refund n'accorde rien, refus RLS du client (UPDATE subscriptions/payments/users, audit append-only, cloisonnement A/B).
Suite complète : **593/593** (les 569 existants + 24). `tsc` 0, build OK.

## 11. Recette E2E (exécutée sur le serveur de production)

`python3 tools/flow_licensing.py` → **14 PASS · 0 FAIL** : sortie d'essai → `no_subscription` ; déclaration → accès toujours fermé (`pending`, layout 307) ; console admin → confirmation `confirmed_activated` (expires 2026-11-28) ; `/api/license` concorde ; application ouverte (200) ; 2ᵉ confirmation → `already_confirmed` ; montant inexact → `amount_mismatch` ; suspension → coupé ; réactivation (mois 0, période inchangée) → rendu. Cron : après `declare → confirm → expire` (recette dev), `POST /api/cron/send` → `{'idle': 50, 'skipped:license_expired': 1}` et flip audité (`status=expired` à la relecture).

## 12. Coexistence avec le billing Stripe existant

> **ADDENDUM (2026-10-28)** — Obsolète depuis : Stripe a été **entièrement
> retiré** de l'architecture à la suite de ce rapport. Voir
> `RAPPORT_RETRAIT_STRIPE.md` (inventaire, preuves d'exécution, plan de
> rollback). La décision d'arbitrage décrite ci-dessous est close : le
> licensing manuel est la seule porte d'accès.

Le stack Stripe (routes `api/billing/*`, `lib/billing.ts`, `domain/billing`, compteurs d'usage) est **intact** : migration 0009 purement additive, aucun fichier Stripe modifié, 569 tests préexistants toujours verts. Les deux systèmes coexistent mais sont **indépendants** : le licensing manuel ne lit pas Stripe ; le billing Stripe ne lit pas `subscriptions`. Risque assumé : un client payant via Stripe conserve son entitlement Stripe (accès par l'existant) tandis que le cron/UI vérifient le licensing manuel — en l'état, **c'est le licensing manuel qui fait loi** pour l'accès produit (les espaces Stripe-only seront hors licence s'ils n'ont pas de confirmation manuelle). Point de décision explicite pour l'opérateur : activer Stripe → créer aussi la souscription manuelle (ou pilote rapproché en §16). Rien n'a été supprimé ; la décision d'arbitrage reste réversible.

## 13. Décisions

Voir `DECISIONS.md` #59–65 : déclaration ≠ activation ; validité calculée ; `withExclusive` (un verrou, une connexion) ; admin plateforme = fait DB à écriture col-scopée ; peg XAF fixe et display-only Chariow/Maketou ; gates par couche ; recette par miroirs dev-only.

## 14. Limites & hypothèses

- PGlite = une connexion : la serialization `withExclusive` vaut pour ce runtime ; sur Postgres multi-connexions (Supabase), l'idempotence repose sur `FOR UPDATE` + relecture du statut `pending` dans la transaction — correcte mais à re-tester sur l'instance réelle (les 24 tests valident la sémantique, pas la topologie réseau).
- Le flip d'expiration est **à la lecture** : un cron qui n'aurait aucun envoi dû ne marquera pas l'audit tant que personne ne lit l'entitlement (l'accès reste correctement refusé).
- Les instructions Chariow/Maketou sont statiques (liens) : aucune hypothèse sur leurs API.
- Le montant déclaré par le client n'est qu'une **déclaration** : la vérité est la comparaison au prix attendu, faite à la confirmation par l'admin — un client qui déclare un mauvais montant est rejeté, pas activé.
- Dev seed pose `is_platform_admin=true` (RROS_DEV_SEED=1 uniquement) : en production, la colonne est posée par SQL par l'opérateur.

## 15. Plan de rollback

1. **Couper le gate** sans toucher au schéma : désactiver le produit → `UPDATE products SET enabled=false WHERE id='revenue_recovery_os'` (déploiement inchangé, tout le monde repasse en mode essai/existant ; remettre `enabled=true` pour revenir).
2. **Code** : revert des patchs de surface (layout, api-v1, cron, `/api/license`, pages) — aucun d'eux n'écrit en base ; les 5 server actions peuvent rester sans être exposées.
3. **Schéma** (en dernier, non destructif dans ce sens) : `DROP TABLE IF EXISTS payments; DROP TABLE IF EXISTS subscriptions; DROP TABLE IF EXISTS products; ALTER TABLE users DROP COLUMN IF EXISTS is_platform_admin;` — les données Stripe/essai n'ont jamais été touchées. Sur PGlite (mémoire), un restart sans 0009 suffit.
4. **Preuve de non-régression** : la suite 569 préexistante reste verte avec le module retiré (aucun test ancien ne dépend de 0009 ; les 24 licensing sont isolés dans leur fichier).

## 16. Ce qu'il resterait à faire

- Rejouer les 24 tests de concurrence sur Supabase réel (multi-connexions) avant bascule production.
- Politique d'accompagnement Stripe vs manuel (§12) : décision produit écrite, éventuel pont automatique `stripe.paid → confirmation manuelle pré-remplie`.
- Emails transactionnels (déclaration reçue / confirmée / rejetée) — aujourd'hui signalés par l'historique et l'audit uniquement.
- Export comptable des paiements confirmés (CSV) et rapprochement mensuel.
- Relances de renouvellement J-7/J-1 (courtisées, jamais automatiques sur l'accès).

---
**État final** : vitest **593/593** · `tsc` **0 erreur** · build **OK** · flow licensing **14/14** · cron gate **observé** · serveur de production sain (aucune erreur au log après correction du guard de session `(app)`).
