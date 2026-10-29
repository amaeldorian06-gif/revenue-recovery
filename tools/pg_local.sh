#!/bin/bash
# Base PostgreSQL réelle (binaires natifs, même moteur que Supabase : PG 15+)
# pour valider le RLS multi-connexions et la concurrence hors PGlite.
#   tools/pg_local.sh init    → initialise le cluster (une fois)
#   tools/pg_local.sh db      → crée la base rros si absente
# Le serveur lui-même est lancé en process de fond :
#   node_modules/@embedded-postgres/linux-x64/native/bin/postgres \
#     -D /tmp/rros-pgdata -p 5433 -k /tmp -c listen_addresses=127.0.0.1
# puis la suite tourne avec :
#   RROS_DB_DRIVER=pg DATABASE_URL=postgres://postgres@127.0.0.1:5433/rros npx vitest run
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/node_modules/@embedded-postgres/linux-x64/native/bin"
export PGDATA=/tmp/rros-pgdata
export PATH="$BIN:$PATH"
export LD_LIBRARY_PATH="$ROOT/node_modules/@embedded-postgres/linux-x64/native/lib:${LD_LIBRARY_PATH:-}"

case "${1:-}" in
  init)
    if [ -d "$PGDATA" ]; then echo "cluster déjà initialisé : $PGDATA"; exit 0; fi
    initdb -U postgres -A trust -E UTF8 --no-instructions "$PGDATA" > /tmp/pg_init.log 2>&1
    echo "cluster initialisé dans $PGDATA"
    ;;
  db)
    node -e "
const { Client } = require('$ROOT/node_modules/pg');
const c = new Client({ connectionString: 'postgres://postgres@127.0.0.1:5433/postgres' });
c.connect().then(async () => {
  const r = await c.query(\"select 1 from pg_database where datname='rros'\");
  if (r.rowCount === 0) await c.query('create database rros');
  console.log('base rros prête');
  await c.end();
}).catch((e) => { console.error(e.message); process.exit(1); });
"
    ;;
  stop)
    pg_ctl -D "$PGDATA" -m fast stop || true
    ;;
  *)
    echo "usage: tools/pg_local.sh init|db|stop" >&2
    exit 2
    ;;
esac
