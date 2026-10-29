#!/bin/bash
# Re-seed complet après un restart du serveur (PGlite est en mémoire : tout est
# vide au démarrage). Crée 50 sessions de charge + le workspace principal avec
# le dataset 5 000/60 000/5 000. Usage : bash tools/reseed.sh
set -e
BASE=${BASE:-http://localhost:3000}
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/health" 2>/dev/null || true)
  [ "$code" = "200" ] && break
  sleep 2
done
echo "health=$code"
rm -rf /tmp/perf_cookies; mkdir -p /tmp/perf_cookies
for i in $(seq 0 49); do
  curl -s -c /tmp/perf_cookies/u$i.txt -X POST "$BASE/api/dev/seed" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"w$i-$(date +%s)@agence-bellamy.fr\",\"workspace\":\"Charge W$i\"}" -o /dev/null &
done
curl -s -c /tmp/load08.txt -X POST "$BASE/api/dev/seed" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"perfmain-$(date +%s)@agence-bellamy.fr\",\"workspace\":\"Charge Perf 08\"}" -o /dev/null
wait
echo "cookies: $(ls /tmp/perf_cookies | wc -l)"
curl -s -m 280 -b /tmp/load08.txt -X POST "$BASE/api/dev/load-seed" \
  -H 'content-type: application/json' \
  -d '{"opportunities":5000,"signals":60000,"importRows":5000}'
echo
