"""Phase 05 — parcours HTTP : mesure → écran de résultats → cohérence.

Tout passe par les routes du navigateur et par le cron réel.
"""
import json
import re
import subprocess
import uuid

BASE = 'http://localhost:3000'
JAR = f'/tmp/jar_r_{uuid.uuid4().hex[:6]}.txt'
CRON = 'local-cron-secret'
CK = None


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def seed():
    global CK
    subprocess.run(['curl', '-s', '-c', JAR, '-X', 'POST', f'{BASE}/api/dev/seed',
                    '-H', 'content-type: application/json',
                    '-d', json.dumps({'email': f'm{uuid.uuid4().hex[:6]}@studio-merlot.fr',
                                      'workspace': 'Studio Merlot'})],
                   capture_output=True, text=True)
    for line in open(JAR):
        if 'rros_session' in line:
            CK = line.split('\t')[-1].strip()


def get(path):
    return sh(['curl', '-s', '-H', f'Cookie: rros_session={CK}', f'{BASE}{path}'])


def post_json(path, payload):
    return sh(['curl', '-s', '-X', 'POST', f'{BASE}{path}', '-H', f'Cookie: rros_session={CK}',
               '-H', 'content-type: application/json', '-d', json.dumps(payload)])


def code(path, payload=None, secret=None, method='POST'):
    args = ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', method, f'{BASE}{path}']
    if secret:
        args += ['-H', f'authorization: Bearer {secret}']
    else:
        args += ['-H', f'Cookie: rros_session={CK}']
    if payload is not None:
        args += ['-H', 'content-type: application/json', '-d', json.dumps(payload)]
    return sh(args)


def main():
    seed()

    # 1. Douze semaines d'historique + le job hebdomadaire réel.
    measure = json.loads(post_json('/api/dev/measure', {'weeks': 12, 'perWeek': 34, 'lift': 0.35}))
    print(f"historique → {measure['written']} dossiers sur {measure['weeks']} semaines")

    cron = json.loads(sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/snapshots',
                          '-H', f'authorization: Bearer {CRON}']))
    print('cron      →', {k: cron[k] for k in ('ok', 'workspaces', 'computed', 'failed', 'weekStart')})
    print('cron 2e   →', json.loads(sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/snapshots',
                                       '-H', f'authorization: Bearer {CRON}']))['computed'], 'recalcul idempotent')
    print('sans secret →', code('/api/cron/snapshots', None))

    # 2. L'écran des résultats
    page = get('/fr/results')
    state = re.search(r'data-state="(\w+)"', page)
    headline = re.search(r'data-testid="headline"[^>]*>.*?<p[^>]*>(.*?)</p>', page, re.S)
    panels = {k: (f'data-testid="panel-{k}"' in page) for k in 'abc'}
    print('écran     →', f"état={state.group(1) if state else '?'}",
          '· panneaux', panels,
          '· graphique', '<svg' in page,
          '· journal', 'data-testid="weekly-log"' in page)
    if headline:
        text = re.sub(r'<[^>]+>', '', headline.group(1)).strip()
        print('phrase    →', text[:150])

    # 3. Export CSV
    csv = get('/api/results/export')
    lines = [l for l in csv.strip().splitlines() if l]
    print('export    →', len(lines) - 1, 'lignes ·', lines[0])

    # 4. L'invariant I2 : aucun déplacement de groupe, jamais.
    queue = json.loads(get('/api/queue'))
    opp = queue['items'][0]['opportunityId'] if queue.get('items') else None
    print('groupe    → POST', code(f'/api/opportunities/{opp}/arm', {'arm': 'treatment'}),
          '· PATCH', code(f'/api/opportunities/{opp}/arm', {'arm': 'holdout'}, method='PATCH'))

    # 5. Cohérence : une affaire corrigée après la semaine figée
    incoherent = json.loads(post_json('/api/dev/measure', {'weeks': 12, 'perWeek': 30,
                                                          'lift': 0.35, 'incoherent': True, 'seed': 7}))
    admin = get('/fr/internal/coherence')
    verdicts = re.findall(r'data-testid="verdict-[\d-]+"[^>]*>([^<]+)<', admin)
    print('cohérence →', f"{verdicts.count('OK')} OK · {verdicts.count('INCOHÉRENT')} INCOHÉRENT",
          '· semaines', incoherent.get('weeks'))
    print('admin     → accessible', 'testid="coherence-admin"' in admin,
          '· drapeau visible', 'INCOHÉRENT' in admin)

    # 6. Les mots interdits n'apparaissent que si l'effet est démontré
    page = get('/fr/results')
    state = re.search(r'data-state="(\w+)"', page)
    forbidden = bool(re.search(r'rapporté|gagné|récupéré', page, re.I))
    print('honnêteté →', f"état={state.group(1) if state else '?'}",
          '· mots de résultat présents' if forbidden else '· aucun mot de résultat')

    # 7. Le même écran, avec un effet réel : la phrase change, et elle a le droit.
    seed()
    big = json.loads(post_json('/api/dev/measure', {'weeks': 12, 'perWeek': 200, 'lift': 1.2, 'seed': 11}))
    sh(['curl', '-s', '-o', '/dev/null', '-X', 'POST', f'{BASE}/api/cron/snapshots',
        '-H', f'authorization: Bearer {CRON}'])
    page = get('/fr/results')
    state = re.search(r'data-state="(\w+)"', page)
    head = re.search(r'data-testid="headline"[^>]*>.*?<p[^>]*>(.*?)</p>', page, re.S)
    text = re.sub(r'<[^>]+>', '', head.group(1)).strip() if head else ''
    print('effet     →', f"{big['written']} dossiers · état={state.group(1) if state else '?'}",
          '· « rapporté » autorisé', 'rapporté' in page)
    print('phrase    →', text[:160])


if __name__ == '__main__':
    main()
