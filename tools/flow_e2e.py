"""Parcours complet en HTTP : seed → upload → mapping → report → commit → calibration → pipeline."""
import html, json, re, subprocess, sys, uuid

BASE = 'http://localhost:3000'
JAR = f'/tmp/jar_{uuid.uuid4().hex[:6]}.txt'
CK = None

def curl(args, raw=False):
    cmd = ['curl', '-s', '-H', f'Cookie: rros_session={CK}'] + args
    out = subprocess.run(cmd, capture_output=True, text=True)
    return out.stdout

def seed():
    global CK
    r = subprocess.run(['curl', '-s', '-D', '/tmp/fh.txt', '-c', JAR, '-X', 'POST',
                        f'{BASE}/api/dev/seed', '-H', 'content-type: application/json',
                        '-d', json.dumps({'email': f'flow{uuid.uuid4().hex[:6]}@studio.fr'})],
                       capture_output=True, text=True)
    ws = json.loads(r.stdout)['workspaceId']
    for line in open(JAR):
        if 'rros_session' in line:
            CK = line.split('\t')[-1].strip()
    return ws

def post(path, fields, files=None):
    args = ['-D', '/tmp/post_h.txt', '-o', '/dev/null', '-X', 'POST', f'{BASE}{path}']
    for k, v in fields.items():
        args += ['-F', f'{k}={v}']
    for k, v in (files or {}).items():
        args += ['-F', f'{k}=@{v}']
    curl(args)
    for line in open('/tmp/post_h.txt'):
        if line.lower().startswith('location:'):
            return line.split(':', 1)[1].strip()
    return None

def get(path):
    return curl([f'{BASE}{path}'])

def hiddens(block):
    return dict((html.unescape(m.group(1)), html.unescape(m.group(2) or ''))
                for m in re.finditer(r'<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?', block))

def action_id(block):
    return re.search(r'\$ACTION_ID_([a-f0-9]+)', block).group(1)

def selected(block, field):
    m = re.search(rf'name="map_{field}".*?</select>', block, re.S)
    s = re.search(r'<option value="([^"]*)" selected', m.group(0)) if m else None
    return html.unescape(s.group(1)) if s else ''

def form_with(page, needle):
    i = page.find(needle)
    return page[page.rfind('<form', 0, i): page.find('</form>', i)]

ws = seed()
print(f'workspace {ws[:8]}…')

# 1. upload
page = get('/fr/import')
form = form_with(page, 'type="file"')
f = hiddens(form)
loc = post('/fr/import', {**f, 'locale': 'fr'}, {'file': '/home/user/rros/data/exemple_pipeline.csv'})
imp = loc.split('/import/')[1].split('/')[0]
print(f'1 upload  → {loc}')

# 2. mapping (on garde la détection automatique)
page = get(f'/fr/import/{imp}/mapping')
form = form_with(page, 'name="map_client_name"')
fields = {k: v for k, v in hiddens(form).items() if k != 'importId'}
for fld in ['client_name','amount_cents','sent_at','title','stage','last_touch_at','touch_count','contact_email','external_ref']:
    fields[f'map_{fld}'] = selected(page, fld)
fields['importId'] = imp
loc = post(f'/fr/import/{imp}/mapping', fields)
print(f'2 mapping → {loc}')

# 3. report
page = get(f'/fr/import/{imp}/report')
form = form_with(page, 'importId')
loc = post(f'/fr/import/{imp}/report', hiddens(form) | {'importId': imp})
print(f'3 commit  → {loc}')

# 4. calibration
page = re.sub(r'<!--.*?-->', '', get('/fr/calibration'))
txt = re.sub(r'\s+', ' ', re.sub(r'\|+', '|', re.sub(r'<[^>]+>', '|', page)))
i = txt.find('Voilà ce que')
print('4 calib   →', txt[i:i + 210].replace('|', ' ').strip())

# 5. pipeline
page = get('/fr/pipeline')
rows = re.findall(r'<tr>(.*?)</tr>', page, re.S)
print(f'5 pipeline→ {len(rows) - 1} lignes, filtres :', ' | '.join(
    re.sub(r'<[^>]+>', '', x).strip() for x in re.findall(r'<a href="[^"]*state=[a-z_]+"[^>]*>([^<]+)</a>', page)))

# 6. CSV des refus (avant commit — recalculé à la volée)
csv = curl([f'{BASE}/api/imports/{imp}/rejected'])
print('6 refusées→', len(csv.strip().splitlines()) - 1, 'lignes ;', csv.strip().splitlines()[0][:70])

# 7. édition d'une opportunité
first = re.search(r'href="/fr/pipeline/([0-9a-f-]{36})"', page)
print('7 fiche   →', 'trouvée' if first else 'aucune')
if first:
    op = first.group(1)
    fiche = get(f'/fr/pipeline/{op}')
    form = form_with(fiche, 'name="importId"' if False else 'name="client_name"')
    f2 = hiddens(form)
    vals = dict((m.group(1), html.unescape(m.group(2)))
                for m in re.finditer(r'name="([a-z_]+)"[^>]*value="([^"]*)"', form))
    vals.update({k: v for k, v in f2.items() if k.startswith('$')})
    vals['id'] = op
    vals['amount'] = '12 345,00 €'
    loc = post(f'/fr/pipeline/{op}', vals)
    fiche = get(f'/fr/pipeline/{op}')
    print('  édition →', loc, '| nouveau montant affiché :', '12 345,00' in fiche or '12 345 €' in fiche)

sys.stdout.write('')
