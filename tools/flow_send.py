"""Phase 04 — parcours HTTP complet : brouillon → ton → report → approbation → job d'envoi.

Aucun accès direct à la base : tout passe par les routes que le navigateur utilise,
donc ce script prouve le parcours réel, pas une simulation interne.
"""
import html, json, re, subprocess, uuid

BASE = 'http://localhost:3000'
JAR = f'/tmp/jar_s_{uuid.uuid4().hex[:6]}.txt'
CRON = 'local-cron-secret'
CK = None


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def seed():
    global CK
    subprocess.run(['curl', '-s', '-c', JAR, '-X', 'POST', f'{BASE}/api/dev/seed',
                    '-H', 'content-type: application/json',
                    '-d', json.dumps({'email': f's{uuid.uuid4().hex[:6]}@studio-merlot.fr'})],
                   capture_output=True, text=True)
    for line in open(JAR):
        if 'rros_session' in line:
            CK = line.split('\t')[-1].strip()


def get(path):
    return sh(['curl', '-s', '-H', f'Cookie: rros_session={CK}', f'{BASE}{path}'])


def post_json(path, payload):
    return sh(['curl', '-s', '-X', 'POST', f'{BASE}{path}', '-H', f'Cookie: rros_session={CK}',
               '-H', 'content-type: application/json', '-d', json.dumps(payload)])


def code_of(path, payload, secret=None):
    args = ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST', f'{BASE}{path}']
    if secret:
        args += ['-H', f'authorization: Bearer {secret}']
    else:
        args += ['-H', f'Cookie: rros_session={CK}', '-H', 'content-type: application/json',
                 '-d', json.dumps(payload)]
    return sh(args)


def hiddens(block):
    return dict((html.unescape(m.group(1)), html.unescape(m.group(2) or ''))
                for m in re.finditer(r'<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?', block))


def import_csv():
    page = get('/fr/import')
    i = page.find('type="file"')
    form = page[page.rfind('<form', 0, i):page.find('</form>', i)]
    loc = subprocess.run(
        ['curl', '-s', '-D', '-', '-o', '/dev/null', '-X', 'POST', f'{BASE}/fr/import',
         '-H', f'Cookie: rros_session={CK}']
        + sum([['-F', f'{k}={v}'] for k, v in {**hiddens(form), 'locale': 'fr'}.items()], [])
        + ['-F', 'file=@/home/user/rros/data/exemple_pipeline.csv'],
        capture_output=True, text=True).stdout
    imp = [l.split('/import/')[1].split('/')[0] for l in loc.splitlines() if l.lower().startswith('location')][0]
    get(f'/fr/import/{imp}/mapping')
    page = get(f'/fr/import/{imp}/mapping')
    i = page.find('name="map_client_name"')
    form = page[page.rfind('<form', 0, i):page.find('</form>', i)]
    fields = hiddens(form)
    for f in ['client_name', 'amount_cents', 'sent_at', 'title', 'stage', 'last_touch_at',
              'touch_count', 'contact_email', 'external_ref']:
        m = re.search(rf'name="map_{f}".*?</select>', page, re.S)
        s = re.search(r'<option value="([^"]*)" selected', m.group(0)) if m else None
        fields[f'map_{f}'] = html.unescape(s.group(1)) if s else ''
    fields['importId'] = imp
    submit_form(f'/fr/import/{imp}/mapping', fields)
    page = get(f'/fr/import/{imp}/report')
    i = page.find('importId')
    form = page[page.rfind('<form', 0, i):page.find('</form>', i)]
    submit_form(f'/fr/import/{imp}/report', {**hiddens(form), 'importId': imp})
    return imp


def submit_form(path, fields):
    args = ['curl', '-s', '-X', 'POST', f'{BASE}{path}', '-H', f'Cookie: rros_session={CK}']
    for k, v in fields.items():
        args += ['-F', f'{k}={v}']
    return sh(args)


def action_id_of(page):
    m = re.search(r'actionId\\+"\s*:\s*\\+"([0-9a-f-]{36})', page)
    return m.group(1) if m else None


def body_of(page):
    m = re.search(r'id="draft-body"[^>]*>([^<]*)</textarea>', page)
    return html.unescape(m.group(1)).strip() if m else ''



def main():
    seed()
    import_csv()

    queue = json.loads(get('/api/queue'))
    opp = queue['items'][0]['opportunityId']
    print(f"file      → {len(queue['items'])} dossiers · premier {opp[:8]}")

    card = get(f'/fr/queue/{opp}')
    print('carte     →', 'draft-card' in card, '· éditeur', 'draft-body' in card,
          '· bac à sable', 'Mode bac à sable' in card, '· 3 tons', card.count('data-testid="tone-'))
    draft_id = action_id_of(card)
    print('brouillon →', body_of(card).splitlines()[0], f'· id {draft_id[:8] if draft_id else "—"}')

    # 1. changement de ton : nouveau brouillon, même dossier
    formal = json.loads(post_json('/api/drafts/generate', {'opportunityId': opp, 'tone': 'formal'}))
    formal_id = (formal.get('draft') or {}).get('actionId')
    print('ton formel→', 'ok' if formal.get('draft') else formal.get('reason'),
          f"· {len((formal.get('draft') or {}).get('body', '').split())} mots")

    # 2. report de 7 jours
    snoozed = json.loads(post_json(f'/api/actions/{formal_id}/snooze', {'days': 7}))
    print('report    →', snoozed.get('until', '')[:10], f"(+{snoozed.get('days')} j)")

    # 3. nouveau brouillon puis approbation avec une phrase réécrite
    regen = json.loads(post_json('/api/drafts/generate', {'opportunityId': opp, 'tone': 'warm'}))
    draft = regen['draft']
    final = draft['body'].replace(
        'Avez-vous pu en prendre connaissance ?',
        'Est-ce que le calendrier de novembre vous conviendrait ?',
    )
    approved = json.loads(post_json(f"/api/actions/{draft['actionId']}/approve",
                                    {'finalText': final, 'subject': draft['subject']}))
    print('approve   →', approved.get('ok'), '· écart',
          round(approved.get('editRatio', 0), 4), '· prochaine relance', approved.get('nextFollowUpAt', '')[:10])

    # 4. le job d'envoi : refusé sans secret, un seul envoi avec
    print('cron 403  →', code_of('/api/cron/send', None))
    first = json.loads(sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/send',
                           '-H', f'authorization: Bearer {CRON}']))
    second = json.loads(sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/send',
                            '-H', f'authorization: Bearer {CRON}']))
    print('cron      →', 'envoyés', first['sent'], '· bac à sable', [r.get('sandbox') for r in first['results']],
          '· 2e passage', second['sent'], 'envoi(s)', f"· {first['durationMs']}+{second['durationMs']} ms")

    # 5. la carte est consommée, la file ne la repropose pas
    after = get(f'/fr/queue/{opp}')
    print('après     →', 'Message envoyé' in after, '· carte en lecture seule',
          'readonly-banner' in after, '· aucune relance neuve', action_id_of(after))

    # 6. double refus des garde-fous, prouvé de bout en bout (critère 3)
    guarded = json.loads(post_json('/api/dev/draft', {'opportunityId': opp}))
    print('garde-fous→', 'brouillon', guarded.get('draft'), '· raison', guarded.get('reason'),
          '· appels', guarded.get('providerCalls'), '· persistés', guarded.get('persistedFailures'),
          '· canevas', guarded.get('manualFallback'))

    # 7. mauvaises entrées
    print('invalides →', 'approve vide', code_of(f"/api/actions/{draft['actionId']}/approve", {'finalText': ''}),
          '· dismiss sans raison', code_of(f"/api/actions/{draft['actionId']}/dismiss", {}),
          '· ton inconnu', code_of('/api/drafts/generate', {'opportunityId': opp, 'tone': 'agressif'}),
          '· sans session', sh(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
                                f'{BASE}/api/drafts/generate', '-H', 'content-type: application/json',
                                '-d', json.dumps({'opportunityId': opp, 'tone': 'warm'})]))


if __name__ == '__main__':
    main()
