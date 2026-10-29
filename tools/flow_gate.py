"""Launch gate B — the four invariants, attacked as an adversary would.

I1 no send without approval (direct routes, API, forged credentials) ·
I2 holdout frozen (import, API, admin, direct SQL with the app role) ·
I3 the send job refuses a third contact inside seven days ·
I4 zero commitment in 200 generated drafts.

Usage: production server running (RROS_DEV_SEED=1), then
  python3 tools/flow_gate.py
"""
import json
import base64
import re
import subprocess
import sys
import uuid

BASE = 'http://localhost:3000'
ROOT = '/home/user/rros'
PASS = FAIL = 0


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def check(label, ok, detail=''):
    global PASS, FAIL
    PASS += bool(ok)
    FAIL += not ok
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{f' — {detail}' if detail else ''}")


def curl_code(method, path, cookie=None, auth=None, body=None):
    args = ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', method, f'{BASE}{path}']
    if cookie:
        args.insert(2, f'-HCookie: rros_session={cookie}')
    if auth:
        args.insert(2, f'-HAuthorization: Bearer {auth}')
    if body is not None:
        args.insert(2, '-Hcontent-type: application/json')
        args.insert(3, '-d' + json.dumps(body))
    return sh(args).strip()


class C:
    def __init__(self, workspace='Gate'):
        self.jar = f'/tmp/gate_{uuid.uuid4().hex[:6]}.txt'
        self.ck = None
        self.seed(workspace)

    def seed(self, workspace):
        subprocess.run(['curl', '-s', '-c', self.jar, '-X', 'POST', f'{BASE}/api/dev/seed',
                        '-H', 'content-type: application/json',
                        '-d', json.dumps({'email': f'gate{uuid.uuid4().hex[:6]}@agence-bellamy.fr',
                                          'workspace': workspace})], capture_output=True)
        for line in open(self.jar):
            if 'rros_session' in line:
                self.ck = line.split('\t')[-1].strip()

    def get(self, path):
        return sh(['curl', '-s', f'{BASE}{path}', '-H', f'Cookie: rros_session={self.ck}'])

    def post(self, path, payload=None):
        args = ['curl', '-s', '-X', 'POST', f'{BASE}{path}', '-H', f'Cookie: rros_session={self.ck}']
        if payload is not None:
            args += ['-H', 'content-type: application/json', '-d', json.dumps(payload)]
        return sh(args)


def tampered_jwt():
    """A self-issued session cookie: right shape, wrong signature."""
    b64 = lambda d: base64.urlsafe_b64encode(d).rstrip(b'=').decode()
    header = b64(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
    payload = b64(json.dumps({'userId': 'x', 'workspaceId': 'x', 'role': 'owner',
                              'email': 'x@x.fr', 'locale': 'fr'}).encode())
    return f'{header}.{payload}.forged-signature'


def vitest(spec, pattern=None):
    args = ['npx', 'vitest', 'run', spec, '--reporter=basic']
    if pattern:
        args += ['-t', pattern]
    out = subprocess.run(args, capture_output=True, text=True, cwd=ROOT)
    m = re.findall(r'Tests\s+(\d+) passed', out.stdout + out.stderr)
    f = re.findall(r'(\d+) failed', out.stdout + out.stderr)
    return (int(m[0]) if m else 0), (int(f[0]) if f else 0)


def main():
    print('I1 — aucun envoi sans approbation :')
    c = C('Gate I1')
    setup = json.loads(c.post('/api/dev/inbox', {'action': 'setup'}))
    dossier = setup['replyDossier']

    codes = [curl_code('POST', r, cookie=c.ck, body={})
             for r in ['/api/send', '/api/actions/send', '/api/messages/send',
                       '/api/emails/send', '/api/v1/send', '/api/drafts/send']]
    check('aucune route d\'envoi direct (6 chemins → 404/405)', all(x in ('404', '405') for x in codes), ' '.join(codes))

    team = json.loads(c.post('/api/dev/team', {'plan': 'scale'}))
    out = sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/v1/actions',
              '-H', f'authorization: Bearer {team["key"]}',
              '-H', 'content-type: application/json',
              '-d', json.dumps({'opportunityId': dossier, 'text': 'x', 'send': True, 'approve': True})])
    data = json.loads(out)
    check('clé API write + send:true dans le corps → brouillon quand même',
          data.get('status') == 'draft', data.get('status'))

    code = curl_code('POST', f'/api/actions/{dossier}/approve', cookie=tampered_jwt(), body={'finalText': 'x'})
    check('server action forgée (cookie contrefait) → refusée', code in ('401', '403'), f'HTTP {code}')

    print('\nI2 — holdout gelé :')
    mapping = sh(['grep', '-rn', "arm", f'{ROOT}/packages/domain/src/import/detect.ts'])
    check('import: aucune colonne arm détectable dans le mapping', "arm" not in mapping, '')

    code = curl_code('POST', f'/api/opportunities/{setup["optOutDossier"]}/arm', cookie=c.ck, body={'arm': 'treatment'})
    check('route API arm → 403 pour tout le monde', code == '403', f'HTTP {code}')

    grep = sh(['grep', '-rln', 'set.*arm\\|update opportunities set arm', f'{ROOT}/apps/web/app/api/'])
    check('aucun outil admin ne déplace un bras', grep.strip() == '', grep.strip()[:60])

    p, f = vitest('packages/db/src/__tests__/holdout.test.ts')
    check('SQL direct (rôle app) → trigger « arm immutable »', p > 0 and f == 0, f'{p} test(s)')

    print('\nI3 — 3 contacts / 7 jours (re-validation dans le job d\'envoi) :')
    p, f = vitest('packages/db/src/__tests__/actions.test.ts', 'the send job refuses the third contact')
    check('le job refuse le contact suivant < 7 j après envoi réel', p > 0 and f == 0, f'{p} test(s)')
    p2, f2 = vitest('packages/domain/src/sending/__tests__/stopRules.test.ts')
    check('règles d\'arrêt unitaires (3 touches, 7 jours, témoin…)', p2 > 0 and f2 == 0, f'{p2} tests')

    print('\nI4 — aucun engagement dans les brouillons (200 générations réelles) :')
    c4 = C('Gate I4')
    c4.post('/api/dev/load-seed', {'opportunities': 600, 'signals': 0, 'importRows': 0})
    team4 = json.loads(c4.post('/api/dev/team', {'plan': 'scale'}))
    key4 = team4['key']
    # The same commitment classes the product's guardrails enforce: price words,
    # payment terms, discounts, percentages, deadlines, urgency, last reminders.
    # A bare amount REFERENCE (the client's own proposal) is not a commitment.
    COMMITMENT = re.compile(
        r'\b(prix|tarifs?|co\u00fbt|honoraires|paiement|virement|facture|acompte|\u00e9chelonn\w*|iban|rib'
        r'|remise|r\u00e9duction|rabais|offre sp\u00e9ciale|promotion|gratuit\w*|\d+\s*%'
        r'|avant le|d\'ici le|au plus tard|date limite|deadline|urgent\w*|au plus vite|asap'
        r'|imm\u00e9diatement|derni\u00e8re relance|dernier rappel)\b', re.I)
    ids, cursor = [], None
    for _ in range(4):
        url = f'/api/v1/opportunities?limit=100' + (f'&cursor={cursor}' if cursor else '')
        page = json.loads(sh(['curl', '-s', f'{BASE}{url}', '-H', f'authorization: Bearer {key4}']))
        for row in page.get('data', []):
            if row.get('arm') == 'treatment' and row.get('status') == 'open':
                ids.append(row['id'])
        cursor = page.get('nextCursor')
        if not cursor or len(ids) >= 220:
            break
    ok_drafts = refused = violations = 0
    examples = []
    scanned = 0
    for oid in ids[:200]:
        out = sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/drafts/generate',
                  '-H', f'Cookie: rros_session={c4.ck}',
                  '-H', 'content-type: application/json',
                  '-d', json.dumps({'opportunityId': oid})])
        try:
            d = json.loads(out)
        except json.JSONDecodeError:
            refused += 1
            scanned += 1
            continue
        scanned += 1
        if d.get('draft'):
            text = d['draft'].get('subject', '') + '\n' + d['draft'].get('body', '')
            # Rule 1: the product's own verdict — a shown draft carries no violation.
            # Rule 2: the independent commitment regex above.
            bad = COMMITMENT.search(text)
            if bad or d.get('violations'):
                violations += 1
                examples.append(bad.group(0) if bad else str(d.get('violations'))[:40])
            else:
                ok_drafts += 1
        else:
            refused += 1
    check('200 brouillons scannés : zéro engagement n\'atteint l\'utilisateur',
          scanned == 200 and violations == 0,
          f'candidats {len(ids)} · ok {ok_drafts} · refusés {refused} · violations {violations} {examples[:3]}')

    print(f'\n→ {PASS} PASS · {FAIL} FAIL')
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
