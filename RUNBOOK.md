# RUNBOOK.md — Exploitation et incidents

*Chaque procédure donne la commande exacte. Les commandes `psql` visent la base
de production (Supabase) ; les commandes `curl` visent l'application. En local
(PGlite embarquée), il n'y a ni backup ni psql : re-seed via `bash tools/reseed.sh`
après un restart.*

* **Validation PostgreSQL réel (multi-connexions)** : `bash tools/pg_local.sh init`
  puis lancer `postgres -D /tmp/rros-pgdata -p 5433 -k /tmp` (binaires dans
  `node_modules/@embedded-postgres/linux-x64/native/bin`), `bash tools/pg_local.sh db`,
  puis la suite entière avec
  `RROS_DB_DRIVER=pg DATABASE_URL=postgres://postgres@127.0.0.1:5433/rros npx vitest run`.
  Le passage à Supabase = même commande avec l'URL du projet.*

**Secrets utilisés ci-dessous** (variables d'environnement du process) :
`CRON_SECRET` (crons), `SESSION_SECRET` (cookies JWT), `PAYMENT_BANK_DETAILS`, `CHARIOW_URL`, `MAKETOU_URL` (instructions de paiement manuel),
`WEBHOOK_SECRET_SALT` (chiffrement des secrets d'endpoints), `DATABASE_URL`
(Supabase, production).

---

## 1. Restaurer un backup

### 1.1 Vérifier d'abord l'état courant

```bash
curl -s https://<app>/api/health        # liveness (sans DB)
curl -s https://<app>/api/health/deep   # DB, profondeur file, derniers crons
```

### 1.2 Restore Supabase (production)

```bash
# Backup manuel avant toute manipulation (toujours, d'abord) :
pg_dump "$DATABASE_URL" -Fc -f /tmp/pre-restore-$(date +%F-%H%M).dump

# Restaurer le dump voulu dans la base (les rôles/RLS sont dans le dump) :
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" /backup/rros-2026-10-27.dump

# Vérifier : RLS actif sur les tables tenant + derniers exercices hebdo présents
psql "$DATABASE_URL" -c "select relname, relrowsecurity from pg_class
  where relname in ('opportunities','actions','audit_log');"
psql "$DATABASE_URL" -c "select count(*) from snapshots;"
```

RLS doit renvoyer `true` partout (`relrowsecurity = t`). Si des policies ont
sauté, l'application refuse de démarrer son parcours normal : le test CI
`rls.test.ts` (couverture `information_schema`) est la référence.

### 1.3 Après restore : invalider les sessions et files de travail

```bash
# 1. Vider les files webhook en cours (elles référencent peut-être un état disparu)
psql "$DATABASE_URL" -c "update webhook_deliveries set status='dead',
  last_error='post-restore invalidation' where status='pending';"
# 2. Les recommandations du jour se régénèrent seules au premier accès (cache vide).
```

---

## 2. Rotater une clé

### 2.1 Clé API client (`rrs_live_*` / `rrs_test_*`)

La clé compromised doit cesser de fonctionner AVANT que la remplaçante soit
remise. Les clés sont hashées SHA-256 en base : on manipule par id.

```bash
# Lister les clés du workspace (affiche id, nom, préfixe 8 caractères, jamais la clé)
psql "$DATABASE_URL" -c "select id, name, key_prefix, created_at, revoked_at
  from api_keys where workspace_id='<WS_UUID>' order by created_at;"

# Révoquer immédiatement (l'app vérifie revoked_at à chaque requête) :
psql "$DATABASE_URL" -c "update api_keys set revoked_at = now()
  where id = '<KEY_UUID>' and revoked_at is null;"

# Créer la clé de remplacement et la transmettre au client (canal chiffré) :
# Réglages → API → « Créer une clé » (elle n'est affichée qu'une fois),
# ou par la route interne : POST /api/settings/api-keys (session owner requise).
```

Vérification : `curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer <ANCIENNE>" https://<app>/api/v1/opportunities` → **401**.

### 2.2 Secret de signature des webhooks (`whsec_*`)

Chaque endpoint porte son secret (chiffré au repos). Rotation = recréer
l'endpoint côté Réglages → Webhooks (l'ancien id devient invalide) puis mettre
à jour le secret chez le client. Les livraisons en attente de l'ancien
endpoint sont supprimées avec lui.

### 2.3 Secrets d'application (`CRON_SECRET`, `SESSION_SECRET`)

```bash
# 1. Nouvelle valeur générée :
openssl rand -hex 32

# 2. Mettre à jour la variable dans l'hébergeur puis redémarrer :
#    (supabase/vercel/process manager) — ex. systemd :
systemctl restart rros-web

# SESSION_SECRET : la rotation déconnecte tout le monde (cookies HS256) —
# à faire hors horaires, et l'annonce est dans les notes de version.
```

---

## 3. Rejouer un cron raté

### 3.1 Diagnostic

```bash
# Dernières exécutions (start/end/status/count par cron) :
psql "$DATABASE_URL" -c "select job, status, started_at, finished_at, count
  from job_runs order by started_at desc limit 20;"

# Alerte automatique : /api/health/deep liste les crons en retard (> 2× intervalle)
curl -s https://<app>/api/health/deep | python3 -m json.tool
```

### 3.2 Rejeu manuel — chaque cron est idempotent, rejouer est sans danger

```bash
CRON="authorization: Bearer $CRON_SECRET"
APP=https://<app>

# Tous idempotents (rejouer est sans danger) — sauf mention, pas de paramètre :
curl -s -X POST "$APP/api/cron/queue"            -H "$CRON"   # file du jour (+ expiration fenêtres 6 sem.)
curl -s -X POST "$APP/api/cron/send"             -H "$CRON"   # envois dus
curl -s -X POST "$APP/api/cron/webhooks?force=1" -H "$CRON"   # webhooks : force ignore backoff + verrou
curl -s -X POST "$APP/api/cron/snapshots"        -H "$CRON"   # snapshot hebdo
curl -s -X POST "$APP/api/cron/sync"             -H "$CRON"   # IMAP inbox
curl -s -X POST "$APP/api/cron/retention"        -H "$CRON"   # rétention logs/corps
curl -s -X POST "$APP/api/cron/purge"            -H "$CRON"   # purge RGPD 30 j
curl -s -X POST "$APP/api/cron/trial"            -H "$CRON"   # essais/nudges
```

`?force=1` n'existe que sur `webhooks` : il ignore le backoff et le verrou
anti-chevauchement — à réserver aux rejeux après incident, pas au cron de prod.

### 3.3 Lettres mortes webhooks — rejouer après correction du récepteur

Les livraisons mortes sont visibles dans Réglages → Webhooks (`dead-letters`).
Pour remettre en file après correction du endpoint (les retries 10/60/300 s
ont produit `status='dead'`) :

```bash
psql "$DATABASE_URL" -c "update webhook_deliveries set status='pending',
  next_attempt_at = now(), attempts = 0
  where status='dead' and endpoint_id='<ENDPOINT_UUID>';"
curl -s -X POST "https://<app>/api/cron/webhooks?force=1" -H "$CRON"
```

---

## 4. Désactiver un workspace

Deux niveaux, selon la gravité.

### 4.1 Suspension immédiate (fraude, impayé, incident client)

Soft delete : l'accès est coupé partout (session, RLS, API v1, webhooks), les
données sont conservées 30 jours (fenêtre de rétractation), puis purgés par
`cron/purge` dans l'ordre FK (voir §5).

```bash
psql "$DATABASE_URL" -c "update workspaces set deleted_at = now(),
  purge_at = now() + interval '30 days' where id = '<WS_UUID>';"

# Vérifier : la session est refusée immédiatement.
curl -s -o /dev/null -w '%{http_code}\n' -H "Cookie: rros_session=<cookie>" https://<app>/fr   # → 403/redirect login
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer <cle_du_ws>" https://<app>/api/v1/opportunities  # → 403
```

### 4.2 Rétractation dans les 30 jours

```bash
psql "$DATABASE_URL" -c "update workspaces set deleted_at = null, purge_at = null
  where id = '<WS_UUID>';"
```

### 4.3 Ne JAMAIS faire

Supprimer des lignes directement dans les tables tenant « pour faire propre » :
la purge obéit à l'ordre FK géré par `purgeExpiredWorkspaces` (repo/gdpr.ts) et
écrit l'audit. Une suppression manuelle casse l'intégrité et le journal.

---

## 5. Répondre à une violation de données (breach)

Chronologie en 6 étapes, heure par heure. **Délai RGPD : notification CNIL sous
72 h si risque pour les personnes** (art. 33) — la montre tourne dès la
détection.

### 5.1 Cerner et contenir (< 1 h)

```bash
# Qui, quoi, quand : audit_log (12 mois de rétention, requêtes signées par request_id)
psql "$DATABASE_URL" -c "select created_at, actor_type, action, entity, entity_id
  from audit_log where workspace_id='<WS_UUID>' order by created_at desc limit 100;"

# Traces applicatives structurées (JSON, aucune donnée client dans les logs) :
# requête par request_id dans l'agrégateur (corrélation avec l'entête X-Request-Id).

# Contenir : révoquer la clé ou suspendre le workspace (§2.1 / §4.1)
psql "$DATABASE_URL" -c "update api_keys set revoked_at = now() where workspace_id='<WS_UUID>';"
```

### 5.2 Préserver les preuves (< 2 h)

```bash
pg_dump "$DATABASE_URL" -Fc -f /tmp/forensics-$(date +%F-%H%M).dump
# Congeler les logs applicatifs de la fenêtre (export agrégateur + snapshots)
```

### 5.3 Évaluer le périmètre

Lister les personnes touchées (contacts du/des workspaces concernés) :

```bash
psql "$DATABASE_URL" -c "select distinct c.email, c.full_name
  from contacts c join opportunities o on o.contact_id = c.id
  where o.workspace_id in (<liste des ws>);" > /tmp/personnes-touchées.csv
```

### 5.4 Notifier (délai légal)

- CNIL (responsable de traitement : l'agence cliente ; nous = sous-traitant,
  notification sans délai au client, DPA §« incident de sécurité ») ;
- le client, avec le périmètre exact (5.3) et les mesures prises (5.1) ;
- les personnes, si risque élevé — le client rédige, nous fournissons les faits.

### 5.5 Corriger

Appliquer le correctif (hotfix), faire tourner la suite : `npx vitest run`
puis les parcours `tools/flow_team.py` / `tools/flow_matrix.py`, puis redéployer.

### 5.6 Clôturer

Rapport d'incident (date, périmètre, cause, correctif, prévention) dans
DECISIONS.md ; rotation des secrets exposés (§2.3) même en cas de simple
soupçon.

---

## 6. Divers — incidents courants

| Symptôme | Commande de diagnostic | Remède |
|---|---|---|
| `/api/queue` lent soudain | `psql "$DATABASE_URL" -c "analyze;"` | Un gros import sans ANALYZE dégrade les plans (PERF.md §4) |
| 500 éparses sous charge | `curl -s https://<app>/api/health/deep` | Vérifier `job_runs` et les erreurs récentes ; redémarrer le process si la heap sature |
| Webhook « disabled » | Réglages → Webhooks (20 échecs consécutifs) | Corriger le récepteur, puis `update webhook_endpoints set disabled_at=null, consecutive_failures=0 where id='<E_UUID>';` |
| Utilisateur bloqué magic link | `psql "$DATABASE_URL" -c "select count(*) from auth_attempts where ip='<IP>' and created_at > now() - interval '15 minutes';"` | Le plafond (5/15 min/IP) retombe seul ; ne pas le lever |
| Export RGPD introuvable | `psql "$DATABASE_URL" -c "select token_hash, expires_at from export_requests where workspace_id='<WS_UUID>' order by requested_at desc limit 5;"` | Lien valable 24 h ; régénérer via Réglages → RGPD |
