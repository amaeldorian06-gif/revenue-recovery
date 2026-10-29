# RAPPORT FINAL — Interface « Comptes clients / Créances » (AR Aging)

**Date :** 2026-10-29 · **Périmètre :** MASTER PROMPT « Revenue Recovery OS — Enterprise SaaS UI/UX », onglet Accounts Receivable · **Verdict : livré et prouvé sur données réelles.**

---

## 1. Synthèse

La vue **Comptes clients (créances)** est opérationnelle de bout en bout : agrégat par client des créances de l'espace de travail, scorées par le **moteur de relance existant** (même moteur que la file du jour, `ENGINE_VERSION 2026-10-v1`), KPIs financiers honnêtes, vues prédéfinies = règles métier documentées, filtres/tri/pagination **côté serveur**, export CSV anti-injection, interface FR/EN (défaut FR).

- **Page** : `/fr/ar` (et `/en/ar`) — tableau dense (aucune carte client), badge de priorité « libellé + indice » (la couleur n'est jamais le seul canal), chaque client dépliable (`<details>`) avec détail par créance **traçable vers le dossier pipeline existant** (`/fr/pipeline/<id>`).
- **API** : `GET /api/ar` — `withEntitlement` (401/403), Zod strict (400), format `json|csv`.
- **Preuves** : 14 tests repo (les deux drivers), **24/24** vérifications HTTP live, **14/14** vérifications UI réelles avec captures, suites complètes **PGlite 589 passed + 4 skipped** et **PG réel 593/593**, `tsc` 0 erreur, build production OK, serveur :3000 vérifié vivant.

## 2. Ce qui existait déjà (audit §3) — rien n'a été recréé

- **Moteur** : `packages/domain/src/scoring/` (`score`, `signal`, `explanations`, `ENGINE_VERSION`) — réutilisé tel quel, zéro duplication.
- **Données** : les créances sont les `opportunités` existantes (`client_name`, `amount_cents`, `stage`, `status open/won/lost`, `sent_at`, `last_touch_at`, `arm`, `source`) ; signaux = `signal_events` (14 j) + `contacts.opt_out_at` — via `loadCandidates` de la file.
- **Garde d'accès** : `withEntitlement`, session cookie révocable, entitlement en base — réutilisés, pas réinventés.
- **Constat structurant** : **le schéma ne contient aucune date d'échéance ni aucun paiement**. Toute la sémantique en découle (§4).

## 3. Architecture livrée

| Fichier | Rôle |
|---|---|
| `packages/db/src/repo/ar_shared.ts` | **Contrat documenté** : `PAYMENT_TERM_DAYS=30`, `PRIORITY_BANDS {high≥66, mid≥33}`, `ArFilters/ArOpportunityLine/ArRow/ArKpis/ArSnapshot` |
| `packages/db/src/repo/ar.ts` | `arSnapshot` : scoring (moteur file) → agrégat par client (clé insensible à la casse, casse affichée = rencontre la plus récente, déterministe inter-drivers) → KPIs sur périmètre entier → filtres/tri/pagination |
| `packages/db/src/repo/ar_shared_csv.ts` | `arToCsv` : `;` + BOM, garde anti-injection `=+-@` → apostrophe, guillemets doublés |
| `apps/web/app/api/ar/route.ts` | GET : Zod (q/status/age_min/age_max/priority/view/sort/page/page_size/format), workspace **depuis la session**, CSV = ensemble filtré **entier** (`pageSize:0`) |
| `apps/web/app/[locale]/(app)/ar/page.tsx` | Page serveur : KPIs, vues, formulaire GET (état dans l'URL), tableau dense, `<details>` traçant, pagination serveur, note de méthode en pied de page |
| `packages/i18n/src/messages.*.json` | Clé `nav.ar` (« Créances » / « Receivables ») — onglet inséré dans la topbar entre « File du jour » et « Portefeuille » |
| `packages/db/src/__tests__/ar.test.ts` | 14 tests repo (règles d'argent, agrégat, priorité, filtres, pagination, isolation, CSV) |
| `tools/ar_api_live.mjs` | Preuve live API : 24 vérifications HTTP réelles (signup UI réel → appels `fetch`) |
| `tools/ar_page_walk.mjs` | Preuve live UI : 14 vérifications navigateur réel + captures `screenshots/ar_fr.png`, `ar_en.png` |

Décision enregistrée : **DECISIONS.md #71** (le « risque » renommé priorité de relance avant de mentir ; poids d'étape importés de `STAGE_SCORE` au lieu du doublon inventé ; KPIs avant filtrage ; CSV entier).

## 4. Règles métier — l'argent n'est jamais trompeur

| Règle | Définition implémentée (et affichée) |
|---|---|
| **Encours ouvert** | Σ des créances au statut « ouverte » uniquement |
| **Échu (terme 30 j)** | ouverte dont l'**ancienneté** depuis `sent_at` dépasse 30 j — libellé « ancienneté », jamais « retard » seul (aucune date d'échéance n'existe) |
| **DSO** | **toujours null** → l'UI affiche « Données insuffisantes — aucune date d'échéance ni paiement confirmé dans le schéma » |
| **Clôturées gagnantes (30 j)** | statut « gagnée » avec `sent_at` ≤ 30 j, libellé explicite **« statut "gagnée" ≠ encaissement confirmé »** — jamais comptées dans l'encours |
| **Indice de priorité** | score du moteur existant normalisé 0-100 **dans l'espace** (meilleur client = 100) ; bandes ≥66/≥33 ; c'est une **priorité de relance** (valeur attendue × urgence), **pas une probabilité d'impayé** — dit en toutes lettres en pied de page |
| **Facteurs d'explication** | ceux d'`explanations.ts` du moteur (ouvertures 14 j, historique de réponse, maturité du stade, silence, fenêtre, montant) — rendus tels quels, ou « Pas assez de données pour expliquer » |

Vues prédéfinies (règles documentées au survol) : **Tous les clients** · **Priorité haute** (bande ≥ 66) · **Très en retard** (ancienneté ≥ 90 j et échu) · **Sans contact récent** (dernier contact > 45 j ou jamais).

## 5. Preuves exécutées (aucun succès simulé)

- **Tests repo (base réelle)** : `ar.test.ts` **14/14 sur PGlite ET sur PG 18.4 réel** — encours/échu/compartiments, agrégat client (casse, ancienneté max, tri des lignes par score), priorité normalisée (meilleur = 100), statuts `won`/`lost`/`all`, `q` client **ou** objet, tris déterministes, pagination, `pageSize:0` = ensemble entier, workspace vide, isolation inter-espaces, garde CSV.
- **Preuve live API (`tools/ar_api_live.mjs`) — 24/24** : 401 sans session ; signup **réel via l'UI** ; 200 `no-store` ; KPIs périmètre entier (550 000 ¢) ; échu = seule la ligne à 95 j ; gagnée ≠ encaissée ; DSO `null` ; 3 × 400 (`status=bogus`, `age_min=-3`, `sort` inconnu) ; `q=verne` filtre les lignes sans toucher aux KPIs ; vue `priority_high` ; CSV 200 `text/csv` **BOM vérifié par octets** (`EF BB BF`), `x-ar-payment-term-days: 30`, ensemble entier ; **403 `forbidden` code `no_subscription`** quand l'essai est fermé (puis retour 200) ; `workspace_id` passé en query **ignoré** (isolation).
- **Preuve live UI (`tools/ar_page_walk.mjs`) — 14/14** : signup réel, onglet visible, KPIs (5 500 € / 4 500 € / DSO), Delta (gagnée) absent du tableau, badge « Priorité haute · 100 » + facteurs (« ouvert 2 fois ces 14 derniers jours » — ouvertures seedées en base), traçabilité `/fr/pipeline/<id>`, vue → URL `?view=priority_high`, recherche serveur `q=lorin` (1 ligne, KPIs inchangés), EN (« Not enough data », aucun « échu » français). Captures : `screenshots/ar_fr.png`, `ar_en.png`.
- **Suites complètes (serveur stoppé, règle OOM)** : PGlite **589 passed + 4 skipped** ; PG réel **593/593**. `npx tsc --noEmit -p apps/web` = **0 erreur**. `npm run build` OK (`/[locale]/ar` + `/api/ar` au manifest). `:3000` répond 200.

## 6. Sécurité, entitlement, multi-tenant

- 401 sans session, 403 `{error:'forbidden', code:<raison>}` sans licence — **prouvés live** (§5) ; la page `(app)` redirige vers l'abonnement.
- Le **workspace vient toujours de la session** : `workspace_id` en query est ignoré — preuve : le workspace B (vide) voit 0 ligne et 0 €, même en falsifiant le paramètre.
- Toute entrée client passe par **Zod** (énumérations fermées, bornes 0–3650 j, page ≤ 10 000) → 400 sinon ; le tri ne peut pas injecter de SQL (énumération).
- CSV : BOM UTF-8, `;`, garde `=+-@` (préfixe `'`) + guillemets doublés — testé (`=HYPERLINK(...)`, `-CMD`).
- Aucune donnée cross-tenant : chaque requête scorée/agrégée est bornée au `workspaceId` de session ; test dédié.

## 7. Limites assumées (rien n'est inventé)

1. **Pas de date d'échéance ni de paiement dans le schéma** → « échu » = convention 30 j **documentée et affichée** ; DSO en état « données insuffisantes » ; gagnée ≠ encaissé.
2. **Indice relatif** : la normalisation 0-100 est **par espace de travail** (le meilleur client = 100) ; 100 ne signifie pas « risque maximal », seulement « à relancer en premier ici ».
3. Les clients **sans ligne ouverte** n'apparaissent pas dans la vue « ouvertes » ; visibles sous statut `won`/`lost`/`all` avec 0 € (sémantique documentée dans le contrat).
4. Le seed de démonstration insère les créances avec `arm='treatment'`, `source='import'` — les créances « sent en prod » hors bac à sable suivraient le même chemin de lecture.
5. Restes connus du système (hors périmètre AR, déjà consignés) : 2FA absente, pas d'UI « mes sessions », `ipOf()` figé en dev.

## 8. Comment re-vérifier

```bash
cd rros
npx tsc --noEmit -p apps/web                                   # 0 erreur
npx vitest run packages/db/src/__tests__/ar.test.ts            # 14/14 (PGlite)
RROS_DB_DRIVER=pg DATABASE_URL=postgres://postgres@127.0.0.1:5433/rros \
  npx vitest run                                               # 593/593 (PG réel)
# serveur :3000 actif (RROS_DB_DRIVER=pg …) puis :
node tools/ar_api_live.mjs                                     # 24/24
LD_LIBRARY_PATH=~/.cache/chrome-libs/extracted/usr/lib/x86_64-linux-gnu \
  node tools/ar_page_walk.mjs                                  # 14/14 + captures
```

**Prochaines étapes naturelles** (non engagées) : brouillons de relance pré-remplis depuis la ligne client (le `arm` et `drafting` existent déjà), rafraîchissement `last_touch_at` branché sur l'envoi réel, et — si un jour le produit le exige — un vrai champ `due_date` qui remplacerait la convention 30 j sans changer l'UI.
