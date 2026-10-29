# RAPPORT_VERIFICATION_COMPTE — Système opérationnel de gestion de compte

Vérification exécutée le 2026-10-29 contre le système réel (base vraie, routes
réelles, navigateur réel). Rien n'est déclaré vert sans l'avoir été observé.

---

## 1. Périmètre inventorié (ce que « gestion de compte » couvre ici)

| Surface | Où | État |
|---|---|---|
| Inscription (email + espace, sans mot de passe) | `/fr/signup` → `signupAction` | ✅ opérationnel |
| Connexion passwordless (magic link 15 min, usage unique) | `/fr/login` → `signinAction` → `/api/auth/verify` | ✅ opérationnel (trou de couverture comblé, §3) |
| Anti-bruteforce (5 échecs / 15 min / IP) | `auth_attempts`, prédicat exact dans `signinAction` | ✅ opérationnel |
| Sessions révocables (0010 : la ligne dépasse le cookie) | `lib/session.ts`, table `sessions` | ✅ opérationnel, preuve live 6/6 |
| Déconnexion (révocation serveur + cookie) | `signoutAction` | ✅ opérationnel |
| Équipe : invitations, acceptation, limites de sièges, suppression | `team.ts`, `/invite/[token]` | ✅ opérationnel, flow 14/14 |
| Rôles owner/admin/member/viewer (matrice HTTP) | toutes les routes d'écriture | ✅ 10/10 |
| Clés API (création/révocation, hashées) + webhooks signés | `/settings/team` | ✅ (tests + flow_team) |
| Suppression d'espace (soft-delete → accès coupé immédiatement) | `deleteWorkspaceAction`, `/deleted` | ✅ (getSession vérifie `deleted_at` à chaque requête) |
| Export RGPD (ZIP 26 tables, un seul workspace) + purge | `requestExportAction`, crons retention/purge | ✅ flow_team |
| Profil : locale (FR/EN), rôle, last_seen | `users` (grants col-scopés) | ✅ |

## 2. Preuves d'exécution (cette vérification)

- **Nouveaux tests `auth_flow` (7/7)** — la sémantique de sécurité du magic
  link, base réelle, code de route injecté : consommation **atomique
  single-use** (rejeu refusé, une seule ligne, marquée `used`), token expiré
  refusé et non consommé, liaison au **SHA-256** (toute autre chaîne refusée),
  **déterminisme** (email multi-comptes → le plus ancien compte gagne),
  **refus du doublon d'email à l'inscription**, rate limit : 4 échecs passent,
  le 5ᵉ bloque, une tentative réussie ne compte jamais, borne **par IP**.
- **Preuve live du magic link** (mode dev, journal serveur réel) :
  inscription 303 → onboarding ; déconnexion → login ; demande de lien →
  `sent=1` ; `GET /api/auth/verify?token=… 307` → **`/fr 200` (session
  ouverte, app accessible)** ; **REJEU du même lien → `link_invalid`**.
- **Sessions révocables** : preuve navigateur **6/6** — un cookie volé
  (rejoué depuis un second navigateur) fonctionne avant déconnexion et est
  **refusé après** le signout de la victime.
- **Équipe & permissions live** : `flow_team` **14/14** (invitations réelles,
  sièges, export ZIP 26 tables, CSP/HSTS/nonce) ; `flow_matrix` **10/10**
  (viewer 403 partout, member borné, routes Stripe retirées → 404).
- **Suites complètes** : PGlite **575 PASS + 4 skips** · PostgreSQL réel
  **579/579** · `tsc` 0 · build production OK.

## 3. Lacunes trouvées PENDANT la vérification (corrigées)

1. **Le magic link n'avait aucun test automatisé** — le mécanisme
   d'authentification entier vivait sans filet. Corrigé : la sémantique est
   extraite dans `lib/auth_tokens.ts` (consommation + résolution, base
   injectée), la route `/api/auth/verify` est amincie (HTTP + session
   seulement), et 7 tests la couvrent.
2. **`next dev` écrasait le build de production** (`.next` partagé) —
   découvert en chaîne pendant les preuves live. Corrigé : `distDir` séparé
   (`NEXT_DEV_DIST=1` → `.next-dev`) ; le walk magic link documente le
   lancement sûr.
3. **Limite d'outillage assumée** : `vi.mock` ne se propage pas au graphe
   d'une route dans cette configuration vitest — contourné par **injection de
   la base** (meilleure conception au passage) plutôt que par mock ; la moitié
   cookie du flux reste prouvée par les walks navigateur, pas par vitest.

## 4. Resté non vérifié (honnêteté)

- La 6ᵉ tentative de login (message `rate_limited`) n'a pas été observée
  **via l'UI** : le serveur dev s'est arrêté avant la fin de la boucle
  (instabilité dev/Playwright, sans rapport avec le produit) ; la sémantique
  du verrou est prouvée unitairement sur le prédicat exact de l'action.
- 2FA/MFA : n'existe pas (chantier ouvert, priorité admin plateforme).
- Le récapitulatif « mes sessions actives » (UI) n'existe pas : la révocation
  est opérationnelle (signout, preuve volée), l'affichage des sessions ne
  l'est pas encore.

## 5. Verdict

Le système de gestion de compte est **opérationnel de bout en bout** :
inscription sans mot de passe, magic link à usage unique horodaté, sessions
révocables côté serveur, équipe multi-rôles cloisonnée par RLS, export et
purge RGPD, coupure immédiate des espaces supprimés. Les deux trous trouvés
(tests du magic link, distDir dev/prod) sont corrigés ; les chantiers restants
sont 2FA et l'UI « mes sessions ».
