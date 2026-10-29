#!/bin/bash
# Launch gate D1 — restore drill, timed. Run on STAGING against a real backup
# before the first euro is charged; RUNBOOK.md §1 is the procedure this
# automates. Fails loudly if the restored base fails any post-restore check.
#
# Usage:  DATABASE_URL="postgres://…staging…" BACKUP=/backups/rros.dump bash tools/backup_drill.sh
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL du staging requis}"
BACKUP="${BACKUP:?chemin du dump à restaurer requis}"
R "${APP_URL:-https://staging.example.com}"

step() { echo "[$(date +%H:%M:%S)] $1"; }

step "0. Backup de sécurité AVANT le restore (toujours)"
t0=$(date +%s)
pg_dump "$DATABASE_URL" -Fc -f "/tmp/pre-drill-$(date +%F-%H%M).dump"
step "   → $(($(date +%s) - t0))s"

step "1. Restore pg_restore --clean (chronométré — objectif < 5 min sur staging)"
t0=$(date +%s)
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" "$BACKUP"
RESTORE_S=$(( $(date +%s) - t0 ))
step "   → restore ${RESTORE_S}s"

step "2. RLS actif sur les tables tenant (tout doit être 't')"
psql "$DATABASE_URL" -tAc "select bool_and(relrowsecurity) from pg_class
  where relname in ('opportunities','actions','recommendations','audit_log','contacts');" \
  | grep -q t || { echo "ÉCHEC: RLS inactif après restore"; exit 1; }

step "3. Données de mesure présentes (snapshots, job_runs)"
psql "$DATABASE_URL" -tAc "select count(*) from snapshots;" | grep -qv '^0$' \
  || echo "AVERTISSEMENT: snapshots vides — vérifier la fraîcheur du dump"

step "4. Invalidation post-restore (RUNBOOK §1.3) : files webhook vidées"
psql "$DATABASE_URL" -c "update webhook_deliveries set status='dead',
  last_error='post-restore invalidation' where status='pending';" > /dev/null

step "5. L'application sert à nouveau"
curl -sf "${APP_URL}/api/health" | grep -q ok || { echo "ÉCHEC: liveness"; exit 1; }
curl -sf "${APP_URL}/api/health/deep" | grep -q '"db":true' || { echo "ÉCHEC: deep"; exit 1; }

step "RESTORE_DRILL_OK — restore ${RESTORE_S}s · RLS vérifié · app verte"
