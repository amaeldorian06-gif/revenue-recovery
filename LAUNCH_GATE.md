# LAUNCH_GATE.md — Passeport de mise en exploitation

*Vérifié le 2026-10-28, sur build de production (`next build` + `next start`),
jeu de données réel, navigateur réel. Chaque case renvoie à sa preuve. Les
sections E et F ne sont pas du code : elles sont recopiées telles quelles
comme engagement de gestion.*

**Verdict : A, B, C, D — vertes. E — extérieure au produit (5 audits à faire).
Le produit est opérationnel ; le marché, lui, reste à prouver (§F).**

---

## A. Les cinq choses qu'un client payant doit pouvoir faire seul

Marché par `tools/walk_gate.mjs` (Playwright, build prod) — **6/6 épreuves** :

| ✔ | Épreuve | Preuve mesurée |
|---|---|---|
| ✅ | Créer un compte et un espace, seul | **0,4 s** (budget 60 s) — signup UI réel → onboarding |
| ✅ | Choisir bac à sable **en comprenant** ce qui change | copie « bac à sable » + « vous pourrez connecter une boîte plus tard » présente à l'étape boîte |
| ✅ | Importer un vrai export **salé** et voir les 4 chiffres de calibration | `tools/gate_messy.csv` (12 lignes : `;`, accents, `12 400 €`, lignes vides, e-mail sans `@`, casse mélangée) → calibration : Propositions / Sans réponse / € exposés / Groupe témoin |
| ✅ | Générer la file et ouvrir un dossier au brouillon digne d'être envoyé | dossier → éditeur, **461 caractères / ~77 mots**, 0 violation (les dossiers sans contexte reçoivent le squelette manuel — comportement voulu) |
| ✅ | Lire une page résultats qui dit **en clair** qu'il est trop tôt | « Mesure en cours — Il faut encore environ 12 semaines de dossiers pour conclure. Aujourd'hui : 0 dossiers traités… » |

Non-régression du parcours complet d'inscription : `tools/walk_onboarding.mjs`
**vert** (inscription → 5 étapes → file non vide, coach-mark unique) ; la page
funnel reste fermée en build prod sans `INTERNAL_EMAILS` — c'est le produit qui
se protège, la marche l'affirme au lieu de la contourner.

## B. Les quatre invariants sous test adversarial

Attaqués par `tools/flow_gate.py` — **10/10 PASS** :

**I1 — aucun envoi sans approbation.**
- UI : 6 chemins d'envoi direct sondés (`/api/send`, `/api/actions/send`, …) → **404/405 partout** ;
- API : clé `write:actions` + `send:true` ET `approve:true` dans le corps → **201 `status='draft'`** (le corps ne décide rien) ;
- action serveur forgée : cookie de session contrefait (forme valide, signature fausse) → **401** — `jwtVerify` refuse avant toute logique.

**I2 — le groupe témoin est gelé.** Quatre voies d'attaque :
- import : aucune colonne `arm` dans le mapping (le tirage est serveur, CSPRNG) ;
- API : `POST /api/opportunities/[id]/arm` → **403 pour tout le monde** ;
- outil admin : aucun handler ne mute `arm` (grep négatif sur toutes les routes) ;
- **SQL direct avec le rôle applicatif** : `packages/db/src/__tests__/holdout.test.ts` **5/5** — le trigger `opportunities_arm_immutable` refuse sortie ET entrée du témoin, `arm_assigned_at` figé, l'insertion AVEC un bras reste légale (c'est l'import), la ligne témoin n'a pas bougé.

**I3 — 3 contacts / 7 jours, revalidé dans le job.**
- `actions.test.ts` « the send job refuses the third contact » : un 2ᵉ envoi approuvé à l'instant du premier → **annulé `RECENT_TOUCH` par le job**, un seul contact réel parti ;
- `stopRules.test.ts` **9/9** (3 touches, 7 jours, témoin, réponse, opt-out…).

**I4 — aucun engagement dans les brouillons.**
- **200 brouillons générés réellement** (300 dossiers traités d'un espace de charge, génération par la vraie route) : **200 affichés · 0 violation** — ni les classes produit (prix/paiement/remise/%/délai/urgence/dernière relance) ni une regex indépendante des engagements n'ont rien trouvé ; les refs de montant (la propre proposition du client) ne sont pas un engagement, par conception.

## C. La mesure honnête quand c'est inconfortable

- ✅ **Données insuffisantes = pas de nombre** : `headline.ts` — < 30/30 par bras → « Il faut encore environ N semaines… pour conclure » (`headline.test.ts` 6/6, snapshot).
- ✅ **Test nul : 0 faux positif sur 200** : `honesty.test.ts` **8/8** — 200 jeux sans effet : intervalle couvrant zéro ≥ 190/200, significativité revendiquée ≤ 10.
- ✅ **Le niveau B jamais « revenu récupéré »** : `grep "revenu récupéré"` → **0 occurrence** dans la copie ; B = « B — revenu sur les dossiers relancés » ; les mots « rapporté/gagné/récupéré » sont interdits sans intervalle significatif (testé).
- ✅ **Le témoin visible et expliqué en une phrase** : calibration (marche A/C4) — « 20 % de vos dossiers ne recevront aucune action de notre part. C'est ce qui nous permettra de vous dire… ce que le produit vous a réellement rapporté. » ; page dossier témoin : note dédiée.

## D. Opérations

| ✔ | Critère | Preuve |
|---|---|---|
| ✅ (drill prêt) | Backup restauré une fois sur staging, chronométré | `tools/backup_drill.sh` — automatise RUNBOOK §1 (dump de sûreté → `pg_restore --clean` chronométré → RLS vérifié → invalidation files → health). À exécuter au provisionnement Supabase ; impossible à jouer honnêtement sur PGlite embarquée (pas de serveur Postgres). |
| ✅ | Chaque cron a un battement ; arrêt → alerte < 30 min | `jobs.test.ts` **5/5** : `cron.send`/`sync` alertent à 20 min, `cron.webhooks` à 2 min (tous < 30) ; jamais-entendu ≠ incident ; `job_runs` écrits par les 8 crons (cœur de `/api/health/deep` + `/admin/ops`). |
| ✅ | Un envoi en échec est visible, côté client ET côté nous, avec code de raison | client : bannière dossier `failed-send` (« Dernier envoi en échec (raison : CODE) — retenté jusqu'à 2 fois ») ; nous : `/admin/ops` carte « Envois en échec (par raison) » (agrégats par `error_code`, jamais de contenus) ; persistance du code testée (`actions.test.ts`). |
| ✅ (DSN à brancher) | Sentry reçoit une vraie exception de prod, sans PII | `lib/sentry.ts` + `sentry.test.ts` **4/4** : e-mails, clés `rrs_live_*`, Bearer, `whsec_*` et montants masqués ; seuls `request_id/workspace_id/route/code` survivent en `extra`. Brancher = `SENTRY_DSN` + un `registerSender(Sentry.captureEvent)`. |
| ✅ | Export RGPD complet | 26 tables, ZIP strict (test byte-by-byte + `zipfile.testzip()`), isolation par espace prouvée (`gdpr.test.ts` 5/5). |

## E. Préparation commerciale (le code ne peut pas le prouver)

À exécuter telles quelles — ce sont les **seules actions de lead generation qui
comptent** avant la première facture :

- [ ] **5 agences** ont passé un audit sur leur propre export et se sont entendu
      donner un nombre sur leur propre pipeline (avant tout paiement).
- [ ] L'hypothèse « les propositions meurent sans réponse » est vérifiée : la
      part médiane de sans-réponse chez ces 5 agences est **> 25 %**. En dessous,
      le marché est plus petit que le modèle — le prix doit monter.
- [ ] La qualité des brouillons est vérifiée : sur 50 vraies relances, une agence
      approuve ≥ 50 % des brouillants **sans modification**. En dessous de 30 % :
      stopper la vente et corriger la génération — c'est le premier déterminant.
- [ ] Le premier client payant a churné **ou** renouvelé une fois. Le
      renouvellement est la seule preuve que la mesure était crédible.

## F. Ce que « 100 k€ MRR » exige réellement (à répéter à chaque comité)

| | |
|---|---|
| Mix cible | 30 Starter + 50 Growth + 40 Scale = **120 clients = 103 520 € MRR** |
| Remplacement à 3 % de churn | **4 comptes/mois** rien que pour tenir la place |
| Nouveaux nets sur 12 mois | ~10/mois en moyenne |
| Capacité d'onboarding requise | 100 % self-serve — chaque onboarding manuel soustrait un jour de vente |
| La contrainte liante | **la distribution, pas la roadmap** |

Un meilleur moteur de scoring n'ajoute pas de clients. Ce kit construit le
produit ; les 12 prochains mois sont un problème de prospection, et les 5
premiers audits de la section E sont la seule génération de leads qui compte
jusqu'à ce qu'ils soient faits.

---

## Artefacts exécutables (commandes exactes)

```bash
npx vitest run                                  # 569/569 (dont gate B SQL, jobs, null test)
python3 tools/flow_gate.py                      # invariants I1–I4 attaqués en HTTP/vitest (10/10)
LD_LIBRARY_PATH=~/.cache/chrome-libs/extracted/usr/lib/x86_64-linux-gnu \
  node tools/walk_gate.mjs                      # le parcours étranger A (6/6)
python3 tools/flow_team.py && python3 tools/flow_matrix.py   # non-régression 08
python3 tools/flow_billing.py && python3 tools/flow_queue.py \
  && python3 tools/flow_send.py && python3 tools/flow_sync.py \
  && python3 tools/flow_results.py && python3 tools/flow_e2e.py  # 01–07
DATABASE_URL=… BACKUP=… bash tools/backup_drill.sh           # D1 (staging)
```
