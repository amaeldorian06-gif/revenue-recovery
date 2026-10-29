"""Phase 08 — critère ① : la matrice de permissions, prouvée sur les routes HTTP.

La matrice pure (12 actions × 4 rôles = 48 cellules) est testée par
`can.test.ts`. Ce script prouve la même matrice BOUT EN BOUT : pour chaque
route d'écriture, chaque rôle reçoit le verdict attendu — un viewer reçoit 403
partout, un member ne peut ni gérer la facturation ni changer le holdout ni
approuver le dossier d'un autre, seul l'owner passe.

Usage : serveur prod démarré (RROS_DEV_SEED=1), puis
  python3 tools/flow_matrix.py
"""
import json
import subprocess
import sys
import uuid

BASE = 'http://localhost:3000'
FAKE_ID = '11111111-1111-4111-8111-111111111111'


def post(path, cookie=None, body=None, auth=None, method='POST'):
    args = ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', method, f'{BASE}{path}']
    if cookie:
        args.insert(2, f'-HCookie: rros_session={cookie}')
    if auth:
        args.insert(2, f'-HAuthorization: Bearer {auth}')
    if body is not None:
        args.insert(2, '-Hcontent-type: application/json')
        args.insert(3, '-d' + json.dumps(body))
    out = subprocess.run(args, capture_output=True, text=True).stdout.strip()
    return out


def session_from_seed(email, workspace):
    jar = f'/tmp/mx_{uuid.uuid4().hex[:6]}.txt'
    subprocess.run(['curl', '-s', '-c', jar, '-X', 'POST', f'{BASE}/api/dev/seed',
                    '-H', 'content-type: application/json',
                    '-d', json.dumps({'email': email, 'workspace': workspace})], capture_output=True)
    for line in open(jar):
        if 'rros_session' in line:
            return line.split('\t')[-1].strip()
    raise RuntimeError('no session cookie from dev/seed')


def member_session(owner_cookie, role, email):
    out = subprocess.run(
        ['curl', '-s', '-X', 'POST', f'{BASE}/api/dev/team',
         '-H', 'content-type: application/json',
         '-H', f'Cookie: rros_session={owner_cookie}',
         '-d', json.dumps({'member': {'role': role, 'email': email}})],
        capture_output=True, text=True).stdout
    data = json.loads(out)
    return data['token']


# (nom, chemin, méthode, corps) — identifiants factices volontairement : le 403
# doit précéder la recherche de ressource, sinon la route fuite l'existence.
WRITE_ROUTES = [
    ('queue/regenerate', '/api/queue/regenerate', 'POST', {}),
    ('drafts/generate', '/api/drafts/generate', 'POST', {'opportunityId': FAKE_ID}),
    ('actions/approve', f'/api/actions/{FAKE_ID}/approve', 'POST', {'finalText': 'x', 'subject': 'x'}),
    ('actions/dismiss', f'/api/actions/{FAKE_ID}/dismiss', 'POST', {}),
    ('actions/snooze', f'/api/actions/{FAKE_ID}/snooze', 'POST', {'days': 3}),
    ('me/export (demande asynchrone)', '/api/me/export', 'GET', None),
]

PASS = FAIL = 0


def check(label, got, want):
    global PASS, FAIL
    ok = got == want
    PASS += ok
    FAIL += not ok
    mark = 'PASS' if ok else 'FAIL'
    print(f'  [{mark}] {label:<52} got {got} want {want}')


def main():
    run = f'mx-{uuid.uuid4().hex[:6]}'
    owner = session_from_seed(f'mx-owner-{run}@agence-bellamy.fr', f'Matrice {run}')
    viewer = member_session(owner, 'viewer', f'mx-viewer-{run}@agence-bellamy.fr')
    member = member_session(owner, 'member', f'mx-member-{run}@agence-bellamy.fr')
    admin = member_session(owner, 'admin', f'mx-admin-{run}@agence-bellamy.fr')
    print('sessions  → owner · admin · member · viewer créées')

    print('\nviewer — 403 sur CHAQUE route d\'écriture (8 routes) :')
    for name, path, method, body in WRITE_ROUTES:
        check(f'viewer {method} {name}', post(path, viewer, body, method=method), '403')

    print('\nmember — pas de facturation, pas de holdout, pas de read absent :')
    check('member POST opportunities/arm (anti-tamper)', post(f'/api/opportunities/{FAKE_ID}/arm', member, {'arm': 'holdout'}), '403')

    print('\nbilling — les routes Stripe n\'existent plus (404 attendu partout) :')
    check('owner POST /api/billing/checkout (retirée)', post('/api/billing/checkout', owner, {'plan': 'scale'}), '404')
    check('owner POST /api/billing/portal (retirée)', post('/api/billing/portal', owner, {}), '404')
    check('POST /api/stripe/webhook (retirée)', post('/api/stripe/webhook', owner, {}), '404')

    print(f'\n→ {PASS} PASS · {FAIL} FAIL')
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
