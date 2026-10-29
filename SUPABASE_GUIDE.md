# GUIDE SUPABASE — Brancher le vrai projet (checklist)

Vous êtes sur la page **Intégration GitHub** de Supabase. Ce n'est **pas**
l'étape nécessaire : voici pourquoi, et la marche à suivre dans l'ordre.

---

## 1. Sur cette page : cliquer « Cancel »

L'intégration GitHub de Supabase sert à déployer un dossier `supabase/`
(ses migrations à elle, son `config.toml`). Notre architecture a choisi
l'inverse, documenté dans DECISIONS.md :

- le schéma vit dans `packages/db/migrations/` (0000→0010) ;
- **l'application l'applique elle-même au démarrage** (`migrate()`,
  idempotent, table `schema_migrations`) — sur PGlite comme sur Supabase.

Brancher l'intégration GitHub créerait une **deuxième source de vérité**
pour le schéma, avec un autre nommage de migrations — risque de divergence
pour zéro bénéfice. L'erreur rouge « Branch 'main' not found » signifie
seulement que votre dépôt GitHub est vide ou n'a pas de branche `main`
encore : sans objet ici.

*(Si un jour vous tenez à cette intégration : il faudrait d'abord pousser le
code, puis soit la désactiver au profit des migrations applicatives, soit
déplacer le schéma dans `supabase/migrations/` — un choix d'architecture à
trancher explicitement, pas par défaut.)*

## 2. Pousser le code sur GitHub (indépendant de Supabase)

Depuis l'endroit où vit le code (`rros/`) :

```bash
git init && git add -A && git commit -m "RROS — kit 00-09 + licensing + retrait Stripe"
git branch -M main
git remote add origin https://github.com/amaeldorian06-gif/revenue-recovery.git
git push -u origin main
```

## 3. Récupérer la chaîne de connexion (ce dont Supabase a besoin de vous)

**Project Settings → Database → Connection string → Direct connection**
(port **5432**, mode session — requis pour nos tests, qui font `SET ROLE`
et des transactions multi-instructions ; le pooler transactionnel 6543 ne
les supporte pas). Format :

```
postgresql://postgres:[VOTRE_MOT_DE_PASSE]@db.[ref].supabase.co:5432/postgres
```

## 4. Créer une base de TEST dans le SQL Editor de Supabase

```sql
create database rros_test;
```

⚠️ **Jamais la suite de tests contre la base `postgres`** : elle tronque
tout (c'est son rôle). Le script ci-dessous refuse par construction les
bases `postgres`/`rros` et exige un nom contenant `test`.

## 5. Rejouer les 572 tests contre Supabase

```bash
DATABASE_URL='postgresql://postgres:…@db.…supabase.co:5432/rros_test' \
  bash tools/pg_supabase_suite.sh
```

C'est la **dernière étape de la validation** : mêmes migrations, même RLS,
concurrence multi-connexions réelle. Vert = l'architecture est prouvée sur
la cible de production.

## 6. Brancher l'application (après les tests verts)

Variables d'environnement du déploiement (Vercel/host) :

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | la base **`postgres`** (prod) cette fois — l'app y applique les migrations au boot |
| `SESSION_SECRET` | signature des cookies JWT (32+ caractères, `openssl rand -hex 32`) |
| `CRON_SECRET` | auth des crons (envoi, trial, retention…) |
| `PAYMENT_BANK_DETAILS`, `CHARIOW_URL`, `MAKETOU_URL` | instructions de paiement manuel de `/subscription` |
| `RROS_DEV_SEED` | **ne jamais poser en production** (routes dev) |

Et pour chaque espace client payant : `UPDATE users SET is_platform_admin = true WHERE email = '…';`
via le SQL Editor (l'app ne peut pas écrire cette colonne — par design).

## 7. Sécurité des identifiants

Le mot de passe de la base est un secret fort. Si vous le partagez pour une
manipulation, utilisez un compte/mot de passe de test et **réinitialisez-le
ensuite** (Settings → Database → Reset database password). Ne le collez
jamais dans un ticket, un screenshot ou un commit.
