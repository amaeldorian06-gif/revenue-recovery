# RAPPORT_RETRAIT_STRIPE — Suppression complète du processeur de paiement

Demande : « nous cherchons à retirer complètement Stripe de l'architecture ».
Fait. Tout ce qui est affirmé ici a été **exécuté et observé** après le retrait
(vitest, flows HTTP, parcours Playwright, build production). Date : 2026-10-28.

---

## 1. Résumé exécutif

Aucune brique de paiement Stripe ne subsiste dans le code : ni gateway, ni
checkout/portal, ni webhook, ni machine à événements, ni UI de paiement
intégrée. L'activation du produit passe **exclusivement** par le module de
licences manuelles déjà livré (déclaration client → vérification et
confirmation par l'admin plateforme). Les fonctions **non-Stripe** qui
vivaient dans les mêmes fichiers sont conservées et re-testées : essai de
14 jours, compteurs d'usage et limites de plan, funnel, groupe témoin.

## 2. Inventaire retiré (fichiers supprimés)

| Élément supprimé | Ce que c'était |
|---|---|
| `packages/domain/src/billing/restStripe.ts` | client REST api.stripe.com (pas de SDK npm — jamais de dépendance `stripe`) |
| `packages/domain/src/billing/fakeStripe.ts` | simulateur Stripe (sessions de checkout, événements signés) |
| `packages/domain/src/billing/signature.ts` | vérification des signatures de webhook Stripe |
| `packages/domain/src/billing/stateMachine.ts` | événements Stripe → patch d'état workspace |
| `packages/domain/src/billing/__tests__/` | tests signature + state machine |
| `apps/web/app/api/billing/` | routes `checkout`, `portal`, `fake-pay` |
| `apps/web/app/api/stripe/webhook/` | réception d'événements Stripe |
| `apps/web/lib/actions/billing.ts` | server actions checkout/portal/fake-webhook (sauf holdout → déplacé) |
| `apps/web/app/[locale]/(app)/settings/billing/checkout/` + `portal/` | pages de paiement Stripe |
| `tools/flow_billing.py` | recette E2E du flux Stripe (15 vérifications, obsolètes) |
| exports `./billing/{stateMachine,signature,fakeStripe,restStripe}` | `packages/domain/package.json` |
| path `@rros/domain/billing/fakeStripe` | `apps/web/tsconfig.json` |

Variables d'environnement devenues sans objet : `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` (retirées du RUNBOOK ; aucune lecture restante dans le
code — vérifié par recherche exhaustive « stripe » insensible à la casse).

## 3. Inventaire conservé (non-Stripe, re-testé)

- **Essai 14 jours** : `domain/billing/access.ts` (`accessFor`, bannières
  trial/trial_expired/past_due/canceled), `runTrialJob` + cron `api/cron/trial`
  (emails J-3/J-10, expiration enregistrée une seule fois).
- **Metering & limites** : `getUsage`, `resetUsage`, `assertEntitlement`
  (refus `PLAN_LIMIT_EXCEEDED` audité), sièges/boîtes, plafonds 30/90/300.
- **Funnel** : `recordFunnel`, `FUNNEL_STEPS`, `funnelSummary` (utilisé par le
  seed et l'admin).
- **Groupe témoin (holdout)** : `updateHoldoutAction` déplacé dans
  `lib/actions/holdout.ts` ; le formulaire reste sur la page d'abonnement.
- **Colonnes d'état génériques** de `workspaces` (`subscription_status`,
  `trial_ends_at`, `past_due_at`, `cancel_at_period_end`, `current_period_end`,
  `plan`) : elles décrivent l'état d'abonnement, plus un processeur ; le cron
  d'envoi et la bannière continuent de s'appuyer dessus.

## 4. Réécritures (fichiers modifiés)

- `packages/db/src/repo/billing.ts` — `handleStripeEvent`, `applyPatch` et la
  recherche de workspace par identifiants Stripe supprimés ; `BillingState`
  sans colonnes Stripe ; en-tête documentant le nouveau périmètre.
- `apps/web/lib/billing.ts` — réduit à `currentBilling` (état + accès + usage)
  et `eur()` ; plus aucune gateway.
- `apps/web/app/[locale]/(app)/settings/billing/page.tsx` — devient «
  Abonnement » : état courant, prix des paliers (299/699/1 490 €) et bouton
  vers `/subscription`, contrôle du groupe témoin. Zéro mention Stripe
  (vérifié en HTTP : la page rendue ne contient plus la chaîne).
- `apps/web/components/SubscriptionBanner.tsx` — tous les liens de paiement
  retargetés vers `/{locale}/subscription` ; le faux formulaire vers le portail
  Stripe est supprimé.
- `packages/db/src/repo/licensing.ts` — **transfert de sémantique** : la
  confirmation d'un paiement appelle désormais `resetUsage` (le mois payé
  démarre compteurs à zéro — invariant hérité de l'ancien handler
  `invoice.paid`), avec assertion de test dédiée.
- `tools/flow_matrix.py` — les lignes checkout/portal/fake-pay remplacées par
  des vérifications que les routes retirées répondent **404, y compris au
  propriétaire** (garde anti-réintroduction silencieuse).
- `RUNBOOK.md` (secrets), page `legal` (paiement = virement/Chariow/Maketou),
  commentaire `domain/src/inbox/gmail.ts`.

## 5. Ce qui reste dans le schéma — assumé

Règle de non-destruction : `stripe_events` (table), `workspaces.stripe_customer_id`,
`stripe_subscription_id`, `billing_interval` restent **dans le schéma, jamais
lus ni écrits**. Leur retrait exigerait une migration destructive, explicitement
hors périmètre ; elles sont documentées ici comme résidus inertes. `truncateAll`
continue de vider `stripe_events` (la table existe), sans effet fonctionnel.

## 6. Preuves d'exécution (post-retrait)

- `tsc -p apps/web` (référence CI) : **0 erreur**.
- vitest complet : **564/564** — 593 avant retrait ; la décroissance est la
  somme des tests Stripe supprimés (signature, state machine, critères
  checkout/webhook) et du fichier billing réécrit de 21 à 14 tests.
- `billing.test.ts` réécrit : 14/14 — essai, limites de plan, past_due J+1/J+4,
  retour actif avec compteur remis à zéro, expiration d'essai, job d'essai
  (J-3/J-10/expire une fois), metering sièges/boîtes.
- `licensing.test.ts` : 24/24, dont la nouvelle assertion « compteur à zéro
  après renouvellement confirmé ».
- Build production : **OK**.
- Serveur relancé + reseed (50 espaces, dataset 5 000/60 000) puis :
  - `flow_licensing` : **14/14** (le parcours de paiement manuel est intact) ;
  - `flow_matrix` : **10/10** (dont 3× 404 sur les routes Stripe retirées) ;
  - `flow_gate` : **10/10** ;
  - `walk_gate` (Playwright) : **6/6** ;
  - `/fr/settings/billing` → 200, **aucune occurrence de « Stripe »** dans la
    page rendue ; `/fr/settings/billing/portal` → 404 ; `/fr/subscription` → 200.

## 7. Conséquences produit

- **Une seule porte d'argent** : `/subscription` (déclaration) →
  `/admin/licenses` (confirmation). Aucun chemin de carte, aucun agrégateur.
- Les bannières « Essai », « Envoi en pause », « Passer à l'offre supérieure »
  mènent désormais toutes à la page de licences manuelles.
- Le retrait **rapproche** l'architecture de la contrainte initiale du MASTER
  PROMPT (paiements manuels uniquement) : la coexistence Stripe/licensing
  documentée dans `RAPPORT_LICENSING.md` §12 n'existe plus — la note d'addendum
  y a été ajoutée.

## 8. Limites & hypothèses

- Les espaces qui auraient payé **via Stripe** par le passé n'ont plus aucun
  chemin de renouvellement automatique : leur accès passe désormais par la
  confirmation manuelle (aucun travail de rapprochement n'a été fait — il
  n'existait aucune donnée Stripe réelle dans l'environnement, la gateway
  tournait en mode simulé).
- Le simulateur `fakeStripe` servait aussi de banc d'essai pour la machine à
  états de facturation ; cette couverture disparaît avec lui (les invariants
  conservés sont re-testés en SQL direct).
- `npm run typecheck` (`tsc -b` racine) était déjà orphelin avant ce chantier
  (aucun `tsconfig.json` racine dans le dépôt) ; la commande de référence
  reste celle de la CI : `npx tsc --noEmit -p apps/web`.

## 9. Plan de rollback

1. **Code** : `git revert` des commits du retrait (tout est confiné à des
   fichiers répertoriés en §2/§4 ; aucun schéma modifié).
2. **Env** : réimporter `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` si l'on
   restaure la gateway REST.
3. **Données** : rien à faire — la base n'a pas changé (§5) ; une base
   restaurée d'avant le retrait fonctionne avec le code d'avant le retrait.
4. **Vérification de retour arrière** : relancer la suite 593 (git d'origine),
   build, `flow_billing.py` 15/15.

## 10. État final

vitest **564/564** · `tsc` 0 (réf. CI) · build OK · flow_licensing 14/14 ·
flow_matrix 10/10 (routes Stripe → 404) · flow_gate 10/10 · walk_gate 6/6 ·
serveur de production sain · aucune occurrence fonctionnelle de « Stripe » dans
le code (la chaîne ne subsiste que dans les documents historiques de phases, le
RUNBOOK mis à jour excepté, et ce rapport).
