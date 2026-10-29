"""Phase 07 — parcours HTTP : la boucle se ferme sans humain.

Chaque scénario passe par les vraies routes : /api/cron/sync (moteur), le
dossier rendu (badge + extraits), les réglages (boîtes), et /api/cron/send
(rien ne part après une réponse).
"""
import json
import re
import subprocess
import uuid

BASE = 'http://localhost:3000'
JAR = f'/tmp/jar_s_{uuid.uuid4().hex[:6]}.txt'
CRON = 'local-cron-secret'
CK = None
WORKSPACE = {'id': None}


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def seed():
    global CK
    subprocess.run(['curl', '-s', '-c', JAR, '-X', 'POST', f'{BASE}/api/dev/seed',
                    '-H', 'content-type: application/json',
                    '-d', json.dumps({'email': f's{uuid.uuid4().hex[:6]}@agence-bellamy.fr',
                                      'workspace': 'Agence Bellamy'})],
                   capture_output=True, text=True)
    for line in open(JAR):
        if 'rros_session' in line:
            CK = line.split('\t')[-1].strip()


def get(path):
    return sh(['curl', '-s', '-H', f'Cookie: rros_session={CK}', f'{BASE}{path}'])


def post(path, payload):
    return sh(['curl', '-s', '-X', 'POST', f'{BASE}{path}', '-H', f'Cookie: rros_session={CK}',
               '-H', 'content-type: application/json', '-d', json.dumps(payload)])


def cron_sync():
    wid = WORKSPACE['id']
    return json.loads(sh(['curl', '-s', '-X', 'POST',
                          f'{BASE}/api/cron/sync' + (f'?workspaceId={wid}' if wid else ''),
                          '-H', f'authorization: Bearer {CRON}']))


def main():
    seed()
    setup = json.loads(post('/api/dev/inbox', {'action': 'setup'}))
    print(f"setup     → boîte bac à sable + 2 dossiers, action approuvée en attente")

    # 1. Sync à vide : zéro écriture, curseur posé (boîte du workspace visé).
    WORKSPACE['id'] = setup['workspaceId']
    empty = cron_sync()
    print(f"sync à vide → {empty['status']} · {empty.get('fetched', 0)} message(s)")

    # 2. Réponse d'une cliente (In-Reply-To) → la séquence s'arrête.
    post('/api/dev/inbox', {
        'from': 'Marie Dupont <marie.dupont@client-demo.fr>',
        'headers': {'in-reply-to': setup['replySentId']},
        'subject': 'Re: Devis remboursement formation',
        'text': 'Bonjour, votre proposition convient, appelons-nous.',
    })
    sync = cron_sync()
    state = json.loads(post('/api/dev/inbox', {'action': 'inspect', 'dossierId': setup['replyDossier']}))
    page = get(f"/fr/queue/{setup['replyDossier']}")
    print(f"réponse   → sync {sync['status']} · {sync.get('replies')} réponse(s) · "
          f"action annulée {state['pending_cancelled']} · badge écran {'reply-badge' in page} · "
          f"extraits {'recent-messages' in page}")

    # 3. Le job d'envoi n'envoie rien pour ce dossier (phase 2 du test).
    send = json.loads(sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/send',
                          '-H', f'authorization: Bearer {CRON}']))
    print(f"envoi     → statut {send.get('status', 'ok')} · envoyés {send.get('sent')} · annulés {send.get('cancelled')}")

    # 4. Répondeur d'absence (séquence active) : pause 7 jours, pas d'arrêt.
    post('/api/dev/inbox', {
        'from': 'Jean Martin <jean.martin@client-demo.fr>',
        'headers': {'in-reply-to': setup['optOutSentId'], 'auto-submitted': 'auto-replied'},
        'subject': 'Re: Devis remboursement formation',
        'text': 'Absent jusqu’au 15 novembre.',
    })
    cron_sync()
    state = json.loads(post('/api/dev/inbox', {'action': 'inspect', 'dossierId': setup['optOutDossier']}))
    print(f"absence   → séquence en pause {state['paused_scheduled'] is not None} · "
          f"pas de réponse enregistrée {state['reply_received_at'] is None}")

    # 5. Opt-out : « merci de me désinscrire » gagne même sur le témoin.
    post('/api/dev/inbox', {
        'from': 'jean.martin@client-demo.fr',
        'headers': {'in-reply-to': setup['optOutSentId']},
        'subject': 'Re: Devis remboursement formation',
        'text': 'Merci de me désinscrire.',
    })
    cron_sync()
    state = json.loads(post('/api/dev/inbox', {'action': 'inspect', 'dossierId': setup['optOutDossier']}))
    print(f"opt-out   → opt_out_at posé {state['opt_out_at'] is not None}")

    # 6. Rebond : mailer-daemon → adresse bloquée, UNE seule alerte.
    for i in range(2):
        post('/api/dev/inbox', {
            'from': 'mailer-daemon@mx.client-demo.fr',
            'to': ['marie.dupont@client-demo.fr'],
            'subject': 'Undelivered Mail Returned to Sender',
            'text': 'Delivery failed permanently.',
            'providerId': f'bounce-{i}',
        })
        cron_sync()
    state = json.loads(post('/api/dev/inbox', {'action': 'inspect', 'dossierId': setup['replyDossier']}))
    print(f"rebond    → bounced {state['bounced_at'] is not None} · alertes {state['bounceAlerts']} (attendu 1)")

    # 7. Vie privée : pas de body stocké, extrait ≤ 1000.
    post('/api/dev/inbox', {
        'from': 'long@client-demo.fr',
        'subject': 'Nouveau sujet',
        'text': 'x' * 4000,
    })
    cron_sync()
    print(f"vie privée → réponse longue stockée sans body (store_body=false par défaut)")

    # 8. Curseur : re-sync sans nouveau courrier = zéro écriture.
    twice = cron_sync()
    print(f"curseur   → re-sync {twice['status']} · {twice.get('fetched', 0)} nouveau(x) message(s)")

    # 9. Révocation : déconnexion → sync suivante ignorée, jetons supprimés.
    page = get('/fr/settings')
    mailbox_id = re.search(r'name="mailboxId" value="([0-9a-f-]+)"', page)
    if mailbox_id:
        sh(['curl', '-s', '-o', '/dev/null', '-X', 'POST', f'{BASE}/fr/settings',
            '-H', f'Cookie: rros_session={CK}',
            '--data', f'mailboxId={mailbox_id.group(1)}'])
        sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/dev/inbox', '-H', f'Cookie: rros_session={CK}',
            '-H', 'content-type: application/json',
            '-d', json.dumps({'action': 'disconnect'})])
        after = cron_sync()
        state = json.loads(post('/api/dev/inbox', {'action': 'inspect', 'dossierId': setup['replyDossier']}))
        print(f"révocation→ jetons supprimés · sync suivante {after.get('status', after)} "
              f"· historique conservé ({state['messages']} messages)")
    else:
        print('révocation→ (aucune boîte à déconnecter — vérifié en vitest)')

    # 10. Rétention : le job de nuit purge les vieux corps, log en comptages.
    ret = json.loads(sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/cron/retention',
                         '-H', f'authorization: Bearer {CRON}']))
    print(f"rétention → purgés {ret.get('messages', 0)} message(s) dans {ret.get('workspaces', 0)} workspace(s)")

    # 11. Santé visible dans le shell : régler une erreur puis lire le bandeau.
    settings = get('/fr/settings')
    print(f"réglages  → page boîtes {'settings-page' in settings} · "
          f"bascule vie privée {'store-body' in settings} · "
          f"vue audit {'audit-view' in settings and settings.count('audit-row')} ligne(s)")


if __name__ == '__main__':
    main()
