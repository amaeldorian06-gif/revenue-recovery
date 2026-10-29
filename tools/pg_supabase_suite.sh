#!/bin/bash
# Rejoue la SUITE COMPLÈTE (572 tests) contre une base PostgreSQL MANAGÉE —
# typiquement Supabase — dernière étape de la validation multi-connexions.
#
#   DATABASE_URL='postgresql://postgres:*****@db.xxx.supabase.co:5432/rros_test' \
#     bash tools/pg_supabase_suite.sh
#
# GARDE-FOU : refuse explicitement la base par défaut « postgres » (celle que
# l'application utilisera en production) — la suite TRONQUE tout, elle ne
# doit JAMAIS viser la base de prod. Créez « rros_test » dans le SQL Editor
# de Supabase : create database rros_test;
set -e
cd "$(dirname "$0")/.."

URL="${DATABASE_URL:?DATABASE_URL requis (postgresql://user:pass@host:port/base)}"
DBNAME="${URL%%\?*}"; DBNAME="${DBNAME##*/}"

if [ "$DBNAME" = "postgres" ] || [ "$DBNAME" = "rros" ]; then
  echo "REFUS : la suite tronque toute la base visée. Utilisez une base de test"
  echo "dédiée (ex. rros_test), jamais « postgres » ni « rros »."
  exit 2
fi
case "$DBNAME" in
  *test*|*staging*) ;;
  *) echo "REFUS : le nom de la base doit contenir « test » ou « staging » (trouvé : $DBNAME)."; exit 2 ;;
esac

echo "Cible : …/$DBNAME (suite complète, migrations 0000→0010 incluses)"
RROS_DB_DRIVER=pg DATABASE_URL="$URL" npx vitest run --reporter=basic
