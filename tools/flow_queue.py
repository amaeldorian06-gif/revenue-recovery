"""Phase 03 — parcours HTTP : import → file du jour → API → régénération → cron."""
import html, json, re, subprocess, uuid

BASE = 'http://localhost:3000'
JAR = f'/tmp/jar_q_{uuid.uuid4().hex[:6]}.txt'
CK = None

def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout

def seed():
    global CK
    subprocess.run(['curl','-s','-c',JAR,'-X','POST',f'{BASE}/api/dev/seed',
                    '-H','content-type: application/json','-d',json.dumps({'email':f'q{uuid.uuid4().hex[:6]}@studio.fr'})],
                   capture_output=True, text=True)
    for line in open(JAR):
        if 'rros_session' in line: CK = line.split('\t')[-1].strip()

def get(path):
    return sh(['curl','-s','-H',f'Cookie: rros_session={CK}',f'{BASE}{path}'])

def post(path, fields):
    args = ['curl','-s','-X','POST',f'{BASE}{path}','-H',f'Cookie: rros_session={CK}']
    for k,v in fields.items(): args += ['-F', f'{k}={v}']
    return sh(args)

def hiddens(block):
    return dict((html.unescape(m.group(1)), html.unescape(m.group(2) or ''))
                for m in re.finditer(r'<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?', block))

seed()
# 1. import du fichier réel
page = get('/fr/import')
i = page.find('type="file"')
form = page[page.rfind('<form',0,i):page.find('</form>',i)]
loc = subprocess.run(['curl','-s','-D','-','-o','/dev/null','-X','POST',f'{BASE}/fr/import',
                      '-H',f'Cookie: rros_session={CK}'] +
                     sum([['-F',f'{k}={v}'] for k,v in {**hiddens(form),'locale':'fr'}.items()],[]) +
                     ['-F','file=@/home/user/rros/data/exemple_pipeline.csv'],
                     capture_output=True, text=True).stdout
imp = [l.split('/import/')[1].split('/')[0] for l in loc.splitlines() if l.lower().startswith('location')][0]
get(f'/fr/import/{imp}/mapping')
page = get(f'/fr/import/{imp}/mapping')
i = page.find('name="map_client_name"'); form = page[page.rfind('<form',0,i):page.find('</form>',i)]
fields = hiddens(form)
for f in ['client_name','amount_cents','sent_at','title','stage','last_touch_at','touch_count','contact_email','external_ref']:
    m = re.search(rf'name="map_{f}".*?</select>', page, re.S)
    s = re.search(r'<option value="([^"]*)" selected', m.group(0)) if m else None
    fields[f'map_{f}'] = html.unescape(s.group(1)) if s else ''
fields['importId'] = imp
post(f'/fr/import/{imp}/mapping', fields)
page = get(f'/fr/import/{imp}/report')
i = page.find('importId'); form = page[page.rfind('<form',0,i):page.find('</form>',i)]
post(f'/fr/import/{imp}/report', {**hiddens(form), 'importId': imp})
print('import →', len(get('/fr/pipeline').split('class="list"')) > 1 and 'ok')

# 2. file du jour
page = get('/fr')
cards = re.findall(r'aria-label="Priorité (\d+) sur 100"', page)
names  = re.findall(r'<strong style="font-size:14\.5px">([^<]+)</strong>', page)
whys   = re.findall(r'font-size:13px;color:var\(--ink-2\)">([^<]+)</p>', page)
print(f'file     → {len(cards)} cartes · priorités {cards}')
print('ordre    →', names[:5])
print('why-now  →', whys[0] if whys else '—')
prog = re.search(r'(\d+)/(\d+) traités', page)
print('en-tête  →', prog.group(0) if prog else '—')

# 3. API
api = json.loads(get('/api/queue'))
print(f"API      → {len(api['items'])} items · {api['durationMs']} ms · généré={api['generated']}")

# 4. régénération ×2 puis limite de débit
codes = []
for _ in range(11):
    out = sh(['curl','-s','-o','/dev/null','-w','%{http_code}','-X','POST',f'{BASE}/api/queue/regenerate',
              '-H',f'Cookie: rros_session={CK}'])
    codes.append(out)
print('régén.   →', ' '.join(codes))

# 5. cron sans secret / avec secret
noauth = sh(['curl','-s','-o','/dev/null','-w','%{http_code}','-X','POST',f'{BASE}/api/cron/queue'])
auth = sh(['curl','-s','-X','POST',f'{BASE}/api/cron/queue','-H','authorization: Bearer local-cron-secret'])
print('cron     → sans secret', noauth, '· avec secret', auth[:120])
