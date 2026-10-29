# RAPPORT — Optimisation commerciale internationale « Revenue Recovery OS »

**Date :** 2026-10-29 · **Méthode :** audit d'abord, implémentation vérifiable ensuite, aucun chiffre inventé. **Tout test annoncé ci-dessous a été exécuté dans cette session.**

Statuts utilisés : ✅ **complété et vérifié** · 🟡 **implémenté, test partiel** · 🔵 **recommandé, non implémenté** · 🔴 **bloqué (accès/information manquante)**.

---

## 1. Audit — constats vérifiés (§4 du prompt)

### 1.1 Forces vérifiées (code + tests à l'appui)
- **Produit réel et testé** : import CSV (détection colonnes, encodages, mapping, aperçu, rapport importés/màj/ignorées), moteur de score documenté (`ENGINE_VERSION 2026-10-v1`, formule §7.2, facteurs expliqués, monotonicité testée), file du jour avec éligibilité et rejets motivés, brouillons à validation humaine, groupe témoin (holdout 20 %), exports CSV anti-injection + ZIP complet, vues Créances/Pipeline/Résultats.
- **Sécurité au-dessus du lot** : RLS + grants testés **à chaque suite** y compris tentatives inter-espaces (invariant qui échoue si une nouvelle table y échappe — il m'a attrapée, preuve §3), sessions révocables en base, lien magique à usage unique (rejeu → `link_invalid` prouvé), rate-limit IP, CSP à nonce, journal d'audit, RGPD : purge cascade sous 30 jours, rétentions documentées.
- **Qualité d'ingénierie** : monorepo propre (db/domain/web), 601 tests, migrations transactionnelles auto-appliquées, `tsc` 0 erreur.
- **Déjà présents et sous-exploités** : pages `/legal` (sous-traitants, DPA) et `/legal/data-processing` (tableau rétention) honnêtes et publiques ; API docs publiques ; essai 14 j automatique.

### 1.2 Défauts critiques (avant correction)
1. 🔴 **`/` atterrissait sur un mur de connexion** : aucun visiteur froid ne voyait le produit. P0 conversion.
2. 🔴 **Zéro SEO technique** : pas de robots.txt, pas de sitemap, pas de canonical, pas d'OG, titre générique dupliqué, `<html lang="fr">` en dur (faux sur /en).
3. 🔴 **Zéro mesure d'acquisition** : aucun événement d'entonnoir public ; impossible de savoir d'où viennent les inscrits ni où ils abandonnent.
4. 🔴 **Aucune page publique expliquant le produit, les tarifs ou la sécurité** — un acheteur B2B ne peut ni comprendre ni acheter.
5. 🟡 **Fichier CSV brut conservé indéfiniment** (`imports.staged_rows` après commit) — contradictoire avec l'esprit minimisation.
6. 🟡 Pages privées sans `noindex` (l'auth protège, mais aucune défense en profondeur).

### 1.3 Bloqueurs SEO / conversion / sécurité / perf / mesure
- **SEO** : tous résolus (§5-6) sauf 🔴 **domaine de production inconnu** (canonicals en localhost ; une variable d'env bascule tout — voir §12).
- **Conversion** : onboarding existant solide (écran guidé, import depuis onboarding) ; 🔵 pas de mode démo sans inscription (données d'exemple existent mais exigent un compte) — recommandé §14.
- **Sécurité** : rien de critique trouvé. Routes `/api/dev/*` verrouillées par `RROS_DEV_SEED` (à ne JAMAIS définir en prod — §13). 2FA toujours absente (connu, assumé publiquement sur /security).
- **Perf** : pages marketing pré-rendues (SSG), 103 kB First Load JS, HTML landing 52 kB. Aucun blocage identifié.
- **Mesure** : jalons d'activation existants (`funnel_events` : signup_completed, import_confirmed, mailbox_step_done, essais) — complétés par l'entonnoir public (§7).

### 1.4 Ordre d'implémentation retenu (impact × confiance × effort × risque)
P0 conversion+SEO socle → mesure → actifs contenu → (recommandé) démo sans compte, calculateur, Search Console.

---

## 2. Segment initial recommandé (ICP) et positionnement

**Recommandation — ICP initial : cabinets de conseil, agences et prestataires B2B (5-50 personnes) qui gèrent 20-200 factures ouvertes et font leurs relances depuis un tableur, sans CRM ni outil de recouvrement dédié.**

| Question (§3 du prompt) | Réponse fondée sur le produit vérifié |
|---|---|
| Qui vit le problème le plus souvent ? | Prestataires de services : facturation récurrente par client, petites créances nombreuses (les fixtures du produit — « Cabinet Roche », projets/Charte/Site — dessinent déjà ce profil). **Évidence produit, pas étude de marché.** |
| Qui perd le plus temps/argent ? | Équipes sans credit-manager dédié : la relance dépend de qui y pense. **Hypothèse à valider client.** |
| Qui peut acheter sans procurement d'entreprise ? | PME : 299-1 490 €/mois auto-serve, virement, sans intégration ERP. Cohérent avec les plans existants. |
| Quels outils existants sont insuffisants ? | Tableur (aucune priorisation/explication), suites comptables (rappels génériques, pas de « quoi faire maintenant »), plateformes AR automation (Chaser/Upflow/Kolleno : orientées sync comptable, à partir de ≈ 199-650 £/mois — **prix agrégateurs tiers 2026, non vérifiés chez les éditeurs**). |
| Quel résultat mesurable crédible ? | Temps de décision réduit, délai première relance, effet mesuré **par le holdout intégré** — le seul chiffre que le produit peut honnêtement promettre, c'est la *mesure*, pas un pourcentage de récupération. |
| Pourquoi nous plutôt que le statut quo ? | **Première priorisation utile depuis un simple CSV, sans connecter un système comptable**, avec explications lisibles. Différenciation démontrable dans le code (import→aperçu→file en minutes). |

**Positionnement retenu (vérifiable à chaque mot)** : *« Priorisez vos créances impayées. Savez qui relancer, et pourquoi. »* — importez, lisez la priorité et ses facteurs, organisez l'action suivante. Essai 14 j sans carte, envoi en bac à sable. **Aucun pourcentage de récupération promis.**

🔵 Marchés non enquêtés faute d'accès à des données réelles de demande (volumes, cohortes) : marqués **inconnus**, pas devinés (§9).

---

## 3. Problèmes critiques corrigés (tous vérifiés par test)

| # | Problème | Correction | Preuve |
|---|---|---|---|
| 1 | `/` = mur de connexion | Redirection `/` → `/fr/product` (page publique) | `seo_live` ✓ 307 → `/fr/product` |
| 2 | Aucun robots/sitemap/canonical | `robots.ts`, `sitemap.ts`, canonicals+hreflang par page | `seo_live` ✓ 27/27 |
| 3 | `<html lang="fr">` en dur | Header requête `x-locale` (middleware) → `<html lang>` | ✓ `lang="en"` sur /en/product |
| 4 | Aucune mesure d'acquisition | `analytics_events` (0011) + allowlist + beacons | 8/8 tests + insertions réelles vues en base |
| 5 | CSV brut conservé après commit | `staged_rows/headers → null` au commit | suites import 25/25 ✓ |
| 6 | Privées indexables | `noindex` sur (app), admin, login, signup, subscription, deleted, invite | `seo_live` ✓ |
| 7 | Middleware interceptait robots/sitemap/assets | Matcher exclu (`robots.txt`, `sitemap.xml`, `icon.svg`, `screenshots`, `downloads`) | ✓ 200 sur tous |

---

## 4. Fichiers créés et modifiés

**Créés** : `packages/db/migrations/0011_analytics_events.sql` ; `0012_analytics_rls_lock.sql` ; `apps/web/lib/analytics.ts` ; `apps/web/lib/analytics_client.tsx` ; `apps/web/lib/site.ts` ; `apps/web/app/api/events/route.ts` ; `apps/web/app/[locale]/(public)/layout.tsx` ; `(public)/product/page.tsx` ; `(public)/pricing/page.tsx` ; `(public)/security/page.tsx` ; `apps/web/app/sitemap.ts` ; `apps/web/app/robots.ts` ; `apps/web/app/icon.svg` ; `apps/web/app/[locale]/admin/layout.tsx` (noindex) ; `apps/web/public/screenshots/creances-priorisation.png` ; `apps/web/public/downloads/modele-suivi-creances.csv` ; `exemple-creances.csv` ; `apps/web/lib/__tests__/analytics.test.ts` ; `tools/seo_live.mjs` ; le présent rapport.

**Modifiés** : `apps/web/middleware.ts` (publics, x-locale, cookie `rros_anid` httpOnly sans PII, matcher) ; `apps/web/app/layout.tsx` (metadata de base, lang dynamique) ; `apps/web/app/[locale]/(app)/layout.tsx` (noindex) ; `apps/web/app/[locale]/{login,signup,subscription,deleted,invite/[token]}/page.tsx` (noindex ; signup : ping `signup_started`) ; `apps/web/app/[locale]/(app)/page.tsx` (ping `prioritization_viewed`) ; `packages/db/src/repo/imports.ts` (minimisation) ; `aucune clé i18n modifiée dans cette passe (la nav publique est codée dans le layout) ; `DECISIONS.md` (#72).

---

## 5. Routes SEO implémentées

| Route | Intention servie | État |
|---|---|---|
| `/fr/product`, `/en/product` | Comprendre le produit, CTA essai | ✅ implémentée, testée |
| `/fr/pricing`, `/en/pricing` | Limites et prix réels, modalités d'accès véridiques | ✅ |
| `/fr/security`, `/en/security` | Mesures vérifiées + limites assumées (zéro revendication de certification) | ✅ |
| `/fr/legal`, `/legal/data-processing`, `/docs/api` | Existaient déjà — reliées au footer public | ✅ (existant vérifié) |

🔵 Candidats **recommandés et non créés** (critères du §7 non encore réunis — contenu original à produire) : `/accounts-receivable`, `/invoice-prioritization`, `/ar-aging-report`, `/resources/ar-aging-template` (page), `/resources/overdue-invoice-calculator`, `/resources/receivables-management-guide`, `/about`, `/integrations`. **Aucune page fine ni pays-factice créés délibérément.**

## 6. Metadata, sitemap, robots — détails

- Metadata par page via helper `pageMeta()` : titre/description uniques par locale, canonical absolue auto-référencée, `alternates.languages` fr+en+`x-default`, OpenGraph (siteName, locale fr_FR/en_GB, type website). Template de titres `%s — Revenue Recovery OS`.
- `metadataBase` = `NEXT_PUBLIC_SITE_URL` (défaut localhost — **bloqueur §12** : bascule d'un seul env à l'arrivée du domaine réel).
- `sitemap.xml` : **8 URLs** (4 pages × 2 langues) avec alternates hreflang ; aucune route privée/API/token. `robots.txt` : allow `/`, disallow `/api/` et `/*/admin`, déclaration du sitemap.
- JSON-LD `Organization` + `SoftwareApplication` (offres = vraies constantes `PLANS`), **pas** d'aggregateRating (rien de tel n'existe).
- Favicon `icon.svg` servi (convention Next).
- 🔴 **Search Console** : préparation documentée (§13), vérification impossible sans domaine.

## 7. Actifs de contenu

- ✅ **Modèle de suivi de créances (Asset A, version CSV)** : `downloads/modele-suivi-creances.csv` (en-têtes documentés, 3 lignes d'exemple étiquetées « EXEMPLE »), téléchargeable **sans inscription**, lié depuis la page produit. Colonnes alignées sur l'import réel du produit.
- ✅ **Fichier d'exemple** (données 100 % fictives, formats volontairement irréguliers) : `downloads/exemple-creances.csv`.
- 🔵 **Asset B (calculateur de retard)** et **Asset C (guide de priorisation)** : recommandés (P2, roadmap §14), non créés faute de temps restant — un outil faux ou maigre aurait été pire qu'absent.

## 8. Événements de conversion instrumentés

- **Public (`analytics_events`, allowlist serveur)** : `landing_page_view` (ping page produit), `primary_cta_clicked` / `secondary_cta_clicked` (CTA réels, mesure au clic sans bloquer la navigation), `pricing_viewed`, `signup_started`, `prioritization_viewed` (vue File du jour, répétable). Chaîne navigateur→API→base **prouvée** (insertions lues en base : `landing_page_view` 1, `primary_cta_clicked` 4, `signup_started` 1).
- **Activation (existant, vérifié et conservé)** : `funnel_events` — `signup_completed`, `import_confirmed`, `mailbox_step_done`, jalons d'essai (day3/day10/expired) — idempotents par espace.
- **Garanties de confidentialité testées** : noms d'événements hors allowlist → 400 ; crawlers → refusés ; table **sans aucune colonne** pouvant porter montant/client (test sur `information_schema`) ; `anonymous_id` = UUID aléatoire (cookie httpOnly 180 j) ; props plafonnées (600 o) ; aucun détail de facture ne passe.

## 9. Recherche de mots-clés — cadre (aucun volume inventé)

Accès outils SEO : **aucun**. Volumes/tendances = **inconnus** (étiquetés ainsi, pas estimés). Cadre de décision fourni dans ce rapport, familles candidates classées par pertinence pour l'ICP :

| Famille | Exemples | Intention | Contenu requis | Priorité | Confiance |
|---|---|---|---|---|---|
| Outil/modèle | « modèle suivi créances », « AR aging template » | Outil | Le CSV déjà livré + page qui l'explique | P2 haute | Moyenne (intention claire, volume inconnu) |
| Problème | « prioriser factures impayées », « relancer facture overdue process » | Info→produit | Asset C (guide original) | P2 | Moyenne |
| Commerciale | « logiciel recouvrement créances PME », « accounts receivable software small business » | Comparaison | Page produit + comparaison honnête | P2-P3 | Basse (SERP saturée d'éditeurs établis) |
| Marque | « revenue recovery os » | Navigation | Déjà couverte | — | — |

Règle de décision documentée : n'investir une page que si (a) intention lisible dans la SERP réelle, (b) contribution originale possible, (c) chemin de conversion vers /product, (d) lien interne depuis une page existante.

## 10. Concurrents — matrice compacte (faits sourcés vs hypothèses)

Sources : agrégateurs/blogs comparatifs 2026 ([1](https://quickreceivable.com/blog/best-accounts-receivable-software), [2](https://www.agentcollect.com/blog/best-debt-collection-software), [3](https://duetrail.com/invoice-collection-software)) — **prix non vérifiés auprès des éditeurs** ; à revalider avant tout usage commercial.

| | Chaser | Upflow | Kolleno | **RROS (vérifié dans le code)** |
|---|---|---|---|---|
| Client visé | PME/mid (sync Xero/QBO) | Scale-ups EU/US | Mid-market+ | PME services, tableur→produit |
| Mise en route | sync comptable requis | sync/quote | ERP, 1000+ intégrations | **CSV brut, sans intégration** |
| Priorisation | rappels automatiques + forecasts | reminders + DSO | AI agents O2C | score documenté + facteurs + holdout |
| Prix public | ≈ £199-239/mo (source 3) ; $49 (source 1) — **divergents** | free tier, paid sur devis | ≈ £650/user/mo | **299/699/1 490 € transparents** |
| Explicabilité | n.d. (assumption) | n.d. | n.d. | **formule publiée, facteurs affichés, indice ≠ probabilité d'impayé** |

**Avantage défendable démontrable** : « première priorisation utile en minutes depuis un CSV, explications lisibles, sans connecter votre comptabilité » — propriété du produit vérifiable en démo, pas un slogan. 🔵 À valider par entretiens clients avant campagne.

## 11. Performance — mesures (lab local, pas du field data)

Conditions : sandbox local, `next start` production, mesuré 2026-10-29. **Aucune donnée réelle utilisateur (CRUX/RUM) disponible — le produit n'a pas encore de trafic public.**
- `/fr/product` : TTFB ≈ 20 ms, réponse complète ≈ 26 ms, HTML 52 ko, First Load JS partagé 103 kB (pré-rendu statique : `/[locale]/product|pricing|security` au manifest du build).
- Charge Playwright `waitUntil load` : ≈ 228 ms (machine locale).
- Vitals cibles (LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1) : 🔵 à mesurer sur le domaine réel avec RUM après mise en ligne ; rien ne s'oppose architecturalement (SSG, zéro script tiers, zéro police distante, images rares).
- Application authentifiée : tableaux denses testés jusqu'à 5 000 lignes (p95 file 186 ms).

## 12. Sécurité — vérifications effectuées (cette passe + existant)

- Aucune clé de service exposée : zéro `NEXT_PUBLIC_*` dans le code applicatif (grep vérifié) ; beacons anonymes uniquement.
- RLS : l'ajout d'`analytics_events` a été **refusé par le test invariant** du dépôt → corrigé par policy default-deny (0012) + zéro grant au rôle applicatif — testé (`grants = 0`, insertions par chemin service uniquement).
- Isolation : suites RLS/RLS-invariant/cross-tenant vertes sur les deux drivers (§11 tests) ; `workspace_id` des événements vient de la session, jamais du client.
- API publique `/api/events` : Zod strict, allowlist, refuse les crawlers, aucune lecture, une insertion.
- Privé : `noindex` sur tous les groupes privés ; sitemap sans aucune URL privée ; `/fr/pipeline` → 307 login prouvé.
- Minimisation : `staged_rows/headers` purgés au commit d'import (l'aperçu reste possible avant commit ; refresh en cours d'import toujours couvert).
- **Limites réitérées** (publiées sur /security) : pas de 2FA, pas de SOC 2/ISO, `ipOf()` figé en dev, `RROS_DEV_SEED` à ne jamais définir en production.

## 13. Tests exécutés — résultats réels

| Suite / vérification | Résultat |
|---|---|
| `npx vitest run` (PGlite, serveur stoppé) | **597 passed + 4 skipped** (601) |
| `RROS_DB_DRIVER=pg … npx vitest run` (PG 18.4 réel) | **601/601** |
| `analytics.test.ts` (nouveau) | 8/8 |
| `npx tsc --noEmit -p apps/web` | 0 erreur |
| `npm run build` (production) | ✓ — SSG product/pricing/security, robots, sitemap |
| `node tools/seo_live.mjs` (27 vérifs HTTP réelles : redirection `/`, 200 publics, title/canonical/hreflang/OG/lang, JSON-LD valide, robots+sitemap 8 URLs, noindex privé, 8 liens internes 0 cassé, beacon 204, bot refusé, 400 hors allowlist, flux existants intacts) | **27/27** |
| `node tools/ar_page_walk.mjs` (régression produit) | **14/14** |
| Chaînat analytics navigateur→base (Playwright UA réel) | ✓ 3 événements lus en base |
| Téléchargements publics | ✓ 200/200 |

Non exécutable ici : 🔴 Search Console (domaine requis), 🔴 Lighthouse/CRUX sur domaine réel, 🔴 RUM.

## 14. Blocages restants, déploiement/rollback, roadmap 90 jours

### Blocages et risques
1. 🔴 **Domaine de production inconnu** → canonicals/hreflang/sitemap/OG en `localhost:3000`. **Action unique à l'arrivée du domaine** : définir `NEXT_PUBLIC_SITE_URL=https://…` (une variable, zéro édition de contenu), puis vérifier le domaine dans Search Console, soumettre `/sitemap.xml`.
2. 🔴 **Jamais définir `RROS_DEV_SEED=1` en production** (routes de dev/dev_token). **`NEXT_PUBLIC_SITE_URL` est la seule variable nouvelle requise.**
3. 🔴 Aucune donnée de demande réelle (volumes, concurrents chez l'éditeur, entretiens ICP) — tout chiffre de marché resterait inventé.
4. 🟡 Le bundle client inclut Playwright en dependency racine héritée (pas importé par l'app ; à déplacer en devDep lors d'un passage CI).
5. 🟡 La capture produit affichée est une vraie capture de données de démonstration (jamais de données client réelles dans le marketing — règle respectée).

### Déploiement
1. `npm ci && npm run build` ; provisionner la base cible ; **définir** `RROS_DB_DRIVER=pg`, `DATABASE_URL`, `NEXT_PUBLIC_SITE_URL`, `CRON_SECRET` — **ne pas** définir `RROS_DEV_SEED`. Les migrations 0011/0012 s'appliquent au boot (transactionnel, idempotent).
2. Smokelist post-deploy : `/fr/product` 200 ; `/robots.txt` et `/sitemap.xml` 200 avec l'URL du domaine ; `/fr/pipeline` → 307 login ; `POST /api/events` (événement allowlist) → 204 puis ligne en base ; `/api/dev/seed` → erreur.
3. **Rollback** : redeployer l'image précédente (aucune migration destructive — 0011/0012 purement additives ; la table peut rester en base sans effet sur l'ancien code). Revenir sur `/` = login = revert du middleware (`url.pathname = '/fr'`).

### Roadmap 90 jours (P0 déjà fait)
- **Jours 0-30 (P1 restant)** : domaine + Search Console + soumission sitemap ; instrumenter la lecture RUM ; 5-10 entretiens ICP (cabinets/agences) pour valider segment et prix ; mesurer la baseline funnel (les événements existent) ; 🟡 démo sans inscription (dataset fictif « Voir la démo » réutilisant le seed, étiqueté).
- **Jours 31-60 (P2)** : Asset C — guide original de priorisation (bilingue EN d'abord si entretiens le confirment) ; Asset B — calculateur de retard (client-side, assumptions affichées) ; page `/accounts-receivable` si l'intention SERP le justifie ; données structurées `Article`/`BreadcrumbList` sur les actifs.
- **Jours 61-90 (P2-P3)** : première page comparative honnête (prix éditeurs re-vérifiés à la source) ; expérimentation documentée (hypothèse, métrique primaire, règle de décision) sur le CTA héros ; 🔵 éventuelle 3e langue — seulement après preuve de demande.

---

**Définition du succès (§21) — état** : proposition crédible et spécifique ✅ (vérifiable mot à mot) · découvrabilité ✅ (socle, domaine restant) · chaque landing sert un besoin distinct ✅ (3 pages, pas de doublons) · chemin visiteur→produit ✅ (`/` ne mure plus) · workflow CSV fiable ✅ (déjà testé, régression 14/14) · métriques financières exactes ✅ (601 tests) · données privées protégées ✅ (RLS + noindex + beacon sans PII) · conversion mesurable ✅ (événements en base) · décisions fondées sur preuves ✅ (baseline instrumentée, hypothèses étiquetées).
