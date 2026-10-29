# PERF.md — Mesures de charge, phase 08

*Toutes les valeurs ci-dessous sont des mesures réelles, pas des estimations.
Date : 2026-10-27. Chaque section donne la commande exacte utilisée.*

## 1. Environnement de mesure

| Élément | Valeur |
|---|---|
| Runtime | Node 20, `next build` + `next start` (build de production, **pas** `next dev`) |
| Base | PGlite (Postgres WASM) en mémoire — même moteur de requêtes que le code testé |
| Serveur | `cd apps/web && RROS_DEV_SEED=1 NODE_OPTIONS=--max-old-space-size=640 npx next start -p 3000 -H 0.0.0.0` |
| Machine | sandbox 4 vCPU (les chiffres absolus varient, les rapports de budget restent valides) |

En production cible (Supabase), l'autoanalyze fait le travail que `ANALYZE`
explicite fait ici — voir §4.

## 2. Jeu de données

Créé via `POST /api/dev/load-seed` (route dev, gardée hors production par
`RROS_DEV_SEED=1`), qui exécute le vrai pipeline d'import pour les lignes CSV :

- 5 000 opportunités (`ref-load-*`) réparties sur 400 clients, statuts/stades variés ;
- 4 000 contacts liés (80 %) — sans contact, pas de brouillon possible et la file
  resterait vide ;
- éligibilité calibrée comme une journée réelle : ~80 % candidats,
  ~10 % `TOO_SOON`, ~10 % `TOUCH_LIMIT`, 2 628 `WINDOW_CLOSED` (> 6 semaines) ;
- 60 000 signal_events (`email_open` / `link_click`) sur 14 jours glissants ;
- un import CSV complet de 5 000 lignes (parse → mapping → staging → commit).

Temps de seed mesurés : opportunités 472 ms · signaux 3 088 ms · ANALYZE 176 ms ·
import 5 000 lignes (pipeline complet) 32 ms staging / 4,4 s commit. **Import 5 000
lignes : 4,4 s < 60 s (budget)** — mesuré par `POST /api/dev/load-seed` puis commit
via le flux import réel (phase 03, mesuré au run 1 : 4,4 s).

Commande :

```bash
curl -s -b "$COOKIES" -X POST http://localhost:3000/api/dev/load-seed \
  -H 'content-type: application/json' \
  -d '{"opportunities":5000,"signals":60000,"importRows":5000}'
```

## 3. Résultats (build production)

Commande : `python3 tools/perf_load.py --prod`
(100 appels `/api/queue` · 5 first paints par page · 50 sessions × 60 s).

| Mesure | Résultat | Budget | Verdict |
|---|---|---|---|
| `/api/queue` p50 (n=100) | **14 ms** | — | — |
| `/api/queue` p95 (n=100) | **18 ms** | < 400 ms | ✅ ×22 de marge |
| `/api/queue` erreurs | 0/100 | 0 | ✅ |
| `/fr/pipeline` first paint (médiane, 100 lignes/page) | **261 ms** | < 1 500 ms | ✅ |
| `/fr/results` first paint | **29 ms** | < 800 ms | ✅ |
| `/fr` (dashboard) first paint | **43 ms** | — | ✅ |
| Import 5 000 lignes (pipeline complet) | **4,4 s** | < 60 s | ✅ |
| Concurrence : 50 sessions × 60 s sur `/fr` | **1 870 réponses 200 · 0 erreur (0,00 %)** | < 1 % | ✅ |

Détail premier appel du jour (génération, chemin « premier visiteur à 6 h ») :
`generated:true, 8 items, 578 ms` — une fois par jour et par workspace ; l'appel
suivant sert la table (`generated:false, 10 ms`). Le budget p95 porte sur le
chemin servi depuis `recommendations`, qui est ce que subissent les 50
utilisateurs simultanés.

### Historique avant optimisation (même machine, même dataset)

| Mesure | Avant | Après |
|---|---|---|
| `/api/queue` p50 / p95 | 7 421 / 7 977 ms | 14 / 18 ms |
| `/fr` first paint (médiane) | 14 537 ms | 43 ms |
| `loadCandidates` (workspace 5k) | 6 891 ms | 134 ms |
| deux `count(*)` (opps + signaux) | 7 219 ms | 26 ms |

## 4. Cause racine et correctifs

### 4.1 Plans dégradés faute de statistiques (principal)

Après un bulk insert, le planner PGlite n'a **aucune statistique** et choisit des
nested loops catastrophiques (un `count(*)` joignant 60 000 signaux passait de
26 ms à 7,2 s). Deux correctifs permanentes :

- `POST /api/dev/load-seed` exécute `ANALYZE` après les insertions (176 ms) ;
- `commitImport` (`packages/db/src/repo/imports.ts`) exécute `ANALYZE` après tout
  import de ≥ 500 lignes — un gros import rendrait sinon toutes les requêtes de
  file du workspace 300× plus lentes jusqu'au prochain analyze.

Sur Supabase, `autovacuum`/`autoanalyze` remplissent ce rôle ; le seuil par
défaut d'autoanalyze (50 lignes modifiées par table) garantit un analyze bien
avant 5 000 lignes.

### 4.2 Course d'état de session (corrigée avant ces mesures)

`asWorkspace` mutait `role`/`request.jwt.claims` **au niveau session** sur
l'unique connexion PGlite, avec reset en `finally` : sous charge concurrente, les
requêtes entrelaçaient leurs rôles (une requête admin s'exécutait sous rôle
tenant avec des claims vides → 0 ligne → 500). Correctif
(`packages/db/src/client.ts`) : mutex sérialisant chaque accès
(chaîne de promesses) + ré-entrance par `AsyncLocalStorage`. C'est ce correctif
qui fait passer la concurrence de « 13 916 erreurs / restart serveur » à
**0,00 % d'erreurs**.

### 4.3 Cache de file cassé sur le dataset de charge (corrigé)

`/api/queue` renvoyait `generated:true, items:0` à **chaque** appel : le dataset
de charge créait des opportunités sans contact et systématiquement inéligibles
(`sent_at` à J-0..3, `touch_count` jusqu'à 3) → 5 000 rejets → table vide →
régénération à chaque requête. Correctif : dataset calibré (§2) + contacts liés.
La file se remplit (8 items, capacité du jour) et le cache sert les appels
suivants en 10 ms.

## 5. Benchmark en CI

`packages/db/src/__tests__/bench.test.ts` rejoue le même dataset (5 000/60 000)
sur PGlite à chaque `vitest run` et **échoue au-delà de 2× le seuil** :

- `readQueue` p95 sur 50 appels < **800 ms** (2 × 400 ms) — mesuré : 2 ms ;
- `generateQueue` < **4 000 ms** (marge génération, mesuré : 282 ms).

Mesuré en local au moment de la rédaction :

```
[bench] generateQueue 282 ms · 8 items
[bench] readQueue p50 1 ms · p95 2 ms
Tests  2 passed (2)
```

## 6. Reproduire

```bash
# 1. Build + serve (build de production obligatoire — next dev auto-restarte sous charge)
npm run build --workspace @rros/web
cd apps/web && RROS_DEV_SEED=1 NODE_OPTIONS=--max-old-space-size=640 npx next start -p 3000 -H 0.0.0.0

# 2. Seed complet + mesures (crée lui-même dataset et sessions)
python3 tools/perf_load.py            # mode normal : seed puis mesures
python3 tools/perf_load.py --prod     # mode --prod : réutilise /tmp/perf_cookies/u*.txt
                                      # et le dataset déjà en base

# 3. Benchmark CI (aucun serveur requis)
npx vitest run packages/db/src/__tests__/bench.test.ts
```
