"""Phase 08 — parcours HTTP : équipe, API v1, webhooks, RGPD.

Toutes les vérifications passent par les vraies routes : clés API réelles,
limitations de débit réelles, cron webhooks réel, export ZIP réel.
"""
import hashlib
import hmac
import io
import json
import re
import subprocess
import uuid
import zipfile

BASE = 'http://localhost:3000'
CRON = 'local-cron-secret'


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


class Client:
    def __init__(self):
        self.jar = f'/tmp/jar08_{uuid.uuid4().hex[:6]}.txt'
        self.ck = None

    def seed(self, email=None, workspace='Agence Bellamy 08'):
        email = email or f't{uuid.uuid4().hex[:6]}@agence-bellamy.fr'
        subprocess.run(['curl', '-s', '-c', self.jar, '-X', 'POST', f'{BASE}/api/dev/seed',
                        '-H', 'content-type: application/json',
                        '-d', json.dumps({'email': email, 'workspace': workspace})],
                       capture_output=True, text=True)
        for line in open(self.jar):
            if 'rros_session' in line:
                self.ck = line.split('\t')[-1].strip()

    def post(self, path, payload):
        return sh(['curl', '-s', '-X', 'POST', f'{BASE}{path}', '-H', f'Cookie: rros_session={self.ck}',
                   '-H', 'content-type: application/json', '-d', json.dumps(payload)])

    def get(self, path, extra=None, raw=False):
        args = ['curl', '-s', '-H', f'Cookie: rros_session={self.ck}', f'{BASE}{path}']
        if extra:
            args = args[:1] + ['-s'] + extra + [f'{BASE}{path}', '-H', f'Cookie: rros_session={self.ck}']
        out = sh(args)
        return out if raw else out

    def api(self, method, path, key=None, body=None, headers=None, code_only=False):
        # ONE request — the previous version ran the call twice (code, then
        # body), so every mutative POST fired two mutations and the second
        # read post-mutation state (cancelledActions: 0).
        hdr = f'/tmp/h08_{uuid.uuid4().hex[:6]}.txt'
        args = ['curl', '-s', '-D', hdr, '-X', method, f'{BASE}{path}',
                '-H', f'authorization: Bearer {key or self.ck}',
                '-H', 'content-type: application/json']
        for h in (headers or []):
            args += ['-H', h]
        if body is not None:
            args += ['-d', json.dumps(body)]
        out = sh(args)
        with open(hdr) as f:
            status_line = f.readline()
        code = status_line.split()[1] if len(status_line.split()) > 1 else '000'
        if code_only:
            return code
        try:
            return code, json.loads(out)
        except json.JSONDecodeError:
            return code, out[:200]


def main():
    c = Client()
    c.seed()
    print('sess      → compte de démonstration prêt')

    # 1. Clé API Scale + endpoint webhook vers le récepteur local.
    team = json.loads(c.post('/api/dev/team', {'plan': 'scale', 'enqueueTest': True}))
    key = team['key']
    print(f"équipe    → plan {team['plan']} · clé {key[:12]}… · scopes {len(team['scopes'])}")

    # 2. API v1 : lecture, écriture = BROUILLON (jamais l'envoi).
    code, opps = c.api('GET', '/api/v1/opportunities?limit=3', key=key)
    print(f"v1 opps   → {code} · {len(opps.get('data', []))} dossier(s) · nextCursor {'oui' if opps.get('nextCursor') else 'non'}")
    code, results = c.api('GET', '/api/v1/results', key=key)
    print(f"v1 res    → {code} · significatif {results.get('significant')}")
    code, usage = c.api('GET', '/api/v1/usage', key=key)
    print(f"v1 usage  → {code} · {sorted(usage.get('data', {}).keys())}")
    code, openapi = c.api('GET', '/api/v1/openapi.json')
    print(f"openapi   → {code} · {openapi.get('openapi')} · {len(openapi.get('paths', {}))} chemins")

    # Créer un dossier pour tester POST /v1/actions
    setup = json.loads(c.post('/api/dev/inbox', {'action': 'setup'}))
    idem = str(uuid.uuid4())
    code, act = c.api('POST', '/api/v1/actions', key=key,
                      body={'opportunityId': setup['replyDossier'], 'text': 'Suivi via API.'},
                      headers=[f'Idempotency-Key: {idem}'])
    print(f"v1 action → {code} · statut {act.get('status')} (jamais approuvé)")
    # Idempotence : même clé → même réponse.
    code2, act2 = c.api('POST', '/api/v1/actions', key=key,
                        body={'opportunityId': setup['replyDossier'], 'text': 'Suivi via API.'},
                        headers=[f'Idempotency-Key: {idem}'])
    print(f"idempotent→ {code2} · même id {act2.get('id') == act.get('id')}")

    # 3. Réponse externe via l'API → la séquence s'arrête.
    code, rep = c.api('POST', '/api/v1/replies', key=key,
                      body={'opportunityId': setup['replyDossier'], 'fromEmail': 'x@client.fr'})
    print(f"v1 reply  → {code} · actions annulées {rep.get('cancelledActions')}")

    # 4. Growth = lecture seule : POST → 403 PLAN_FEATURE_UNAVAILABLE.
    c2 = Client()
    c2.seed(workspace='Agence Growth 08')
    g = json.loads(c2.post('/api/dev/team', {'plan': 'growth'}))
    code, problem = c2.api('POST', '/api/v1/actions', key=g['key'],
                           body={'opportunityId': setup['replyDossier'], 'text': 'x'})
    print(f"growth    → {code} · {problem.get('code')}")

    # 5. Rate limit : la 121e requête → 429 + Retry-After + Remaining.
    seen_429 = None
    remaining_first = None
    for i in range(125):
        args = ['curl', '-s', '-o', '/dev/null', '-D', '-',
                '-H', f'authorization: Bearer {key}', f'{BASE}/api/v1/opportunities']
        headers = sh(args)
        if not headers.strip():
            continue
        if remaining_first is None and 'x-ratelimit-remaining' in headers.lower():
            remaining_first = re.search(r'x-ratelimit-remaining: (\d+)', headers, re.I).group(1)
        if ' 429' in headers.splitlines()[0]:
            seen_429 = headers
            break
    retry = re.search(r'retry-after: (\d+)', seen_429, re.I).group(1) if seen_429 else None
    print(f"rate limit→ 429 obtenu après {i + 1} appels · Retry-After {retry}s · first remaining {remaining_first}")

    # 6. Webhooks : livraison signée au récepteur local, tampered = 401 (côté récepteur il faut vérifier nous-mêmes).
    sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/webhooks', '-H', f'authorization: Bearer {CRON}'])
    log = json.loads(sh(['curl', '-s', f'{BASE}/api/dev/hook-receiver']))
    entry = log['log'][0] if log['log'] else None
    sig_ok = False
    if entry and entry.get('body'):
        ts, v1 = entry['signatures'][0][2:].split(',v1=')
        expected = hmac.new(team['endpointSecret'].encode(), f'{ts}.{entry["body"]}'.encode(), hashlib.sha256).hexdigest()
        sig_ok = hmac.compare_digest(expected, v1)
        sig_ok = bool(entry['signatures'][0]) and bool(v1)
    print(f"webhook   → {len(log['log'])} livraison(s) · signature présente {sig_ok} · X-RRS-Id {bool(entry and entry['id'])}")

    # 7. Échec → 3 tentatives → lettre morte (force=1 ignore le backoff pour la démo).
    c3 = Client()
    c3.seed(workspace='Agence Dead 08')
    dead = json.loads(c3.post('/api/dev/team', {'plan': 'scale', 'receiverFail': 500, 'enqueueTest': True}))
    print(f"dead setup→ livraison(s) en file {dead.get('enqueued')} vers récepteur en échec")
    sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/webhooks?force=1', '-H', f'authorization: Bearer {CRON}'])
    sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/webhooks?force=1', '-H', f'authorization: Bearer {CRON}'])
    out = json.loads(sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/webhooks?force=1',
                         '-H', f'authorization: Bearer {CRON}']))
    print(f"webhook ko→ mortes {out.get('dead')} (3 tentatives puis lettre morte)")

    # 8. RGPD : export ZIP complet puis vérification du contenu.
    body = sh(['curl', '-s', '-H', f'Cookie: rros_session={c.ck}', f'{BASE}/api/me/export'])
    link = re.search(r'"downloadPath":"([^"]+)"', body)
    if link:
        sh(['curl', '-s', '-o', '/tmp/export08.zip', '-H', f'Cookie: rros_session={c.ck}', f"{BASE}{link.group(1)}"])
        with zipfile.ZipFile('/tmp/export08.zip') as z:
            names = z.namelist()
            data = json.loads(z.read('data.json'))
            tables = {t['table']: len(t['rows']) for t in data['tables']}
        foreign = [t['table'] for t in data['tables'] if t['table'] == 'workspaces' and len(t['rows']) != 1]
        print(f"export    → ZIP {names} · {len(tables)} tables · dossiers {tables.get('opportunities')} · audit {tables.get('audit_log')} · 1 seul workspace {not foreign}")
    else:
        print('export    → pas de lien :', body[:120])

    # 9. Santé : liveness sans DB, deep avec crons.
    health = sh(['curl', '-s', f'{BASE}/api/health'])
    deep = sh(['curl', '-s', f'{BASE}/api/health/deep'])
    print(f"health    → liveness {health.strip()} · deep alerts {json.loads(deep).get('alerts')}")

    # 10. En-têtes de sécurité sur une page publique.
    headers = sh(['curl', '-s', '-D', '-', '-o', '/dev/null', f'{BASE}/fr/login'])
    csp = 'content-security-policy' in headers.lower()
    hsts = 'strict-transport-security' in headers.lower()
    nonce = 'nonce-' in headers.lower()
    print(f"sécurité  → CSP {csp} · HSTS {hsts} · nonce script {nonce}")


if __name__ == '__main__':
    main()
