"""Licensing HTTP flow — the §12 customer/admin journey against the REAL routes.

Journey: a customer out of trial declares a transfer → access stays closed
(pending) → the platform admin confirms from the console → the product opens
with a real expires_at → suspension closes it → reactivation opens it again.
Adversarial: an out-of-trial workspace cannot use the API (SUBSCRIPTION_REQUIRED),
a double confirmation is idempotent, a bad amount is rejected.

Usage: production server running (RROS_DEV_SEED=1, CRON_SECRET set), then
  python3 tools/flow_licensing.py
"""
import json
import subprocess
import sys
import uuid

BASE = 'http://localhost:3000'
PASS = FAIL = 0


def sh(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def check(label, ok, detail=''):
    global PASS, FAIL
    PASS += bool(ok)
    FAIL += not ok
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}{f' — {detail}' if detail and str(detail) != '' else ''}")


class C:
    def __init__(self, workspace, email=None, platform=False):
        self.jar = f'/tmp/lic_{uuid.uuid4().hex[:6]}.txt'
        r = sh(['curl', '-s', '-c', self.jar, '-X', 'POST', f'{BASE}/api/dev/seed',
                '-H', 'content-type: application/json',
                '-d', json.dumps({'email': email or f'lic{uuid.uuid4().hex[:6]}@agence-bellamy.fr',
                                  'workspace': workspace})])
        self.out = json.loads(r) if r.strip().startswith('{') else {}
        if not self.out.get('workspaceId'):
            raise RuntimeError(f'seed failed: {r[:200]}')
        self.ws = self.out.get('workspaceId')
        self.workspace_name = workspace
        self.ck = open(self.jar).read().split('rros_session')[-1].split('\t')[-1].strip()
        if not platform:
            # The dev seed flags the owner as platform admin; the CUSTOMER must be
            # a plain tenant for the adversarial checks (dev-only revocation).
            sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/dev/licensing', '-H', f'Cookie: rros_session={self.ck}',
                '-H', 'content-type: application/json', '-d', json.dumps({'op': 'revoke-admin'})])

    def dev(self, payload):
        out = sh(['curl', '-s', '-X', 'POST', f'{BASE}/api/dev/licensing', '-H', f'Cookie: rros_session={self.ck}',
                  '-H', 'content-type: application/json', '-d', json.dumps(payload)])
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            return {'raw': out}

    def app_code(self, path='/fr/pipeline'):
        """The (app) layout gate: redirect to /fr/subscription without a licence."""
        # No -L: the redirect itself IS the assertion (307 → /fr/subscription).
        return subprocess.run(
            ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', f'{BASE}{path}',
             '-H', f'Cookie: rros_session={self.ck}'], capture_output=True, text=True).stdout.strip()


def main():
    global FAIL
    print('client — déclaration sans activation :')
    cname = f'Lic Client {uuid.uuid4().hex[:4]}'
    c = C(cname)
    check('fin de l’essai (espace hors funnel)', c.dev({'op': 'end-trial'}).get('ok') is True)
    lic = c.dev({'op': 'entitlement'})
    check('hors essai, sans abonnement → refus no_subscription',
          lic.get('accessAllowed') is False and lic.get('reasonCode') == 'no_subscription',
          f"{lic.get('reasonCode')}")

    dec = c.dev({'op': 'declare', 'plan': 'growth', 'reference': f'TR-{uuid.uuid4().hex[:10]}'})
    check('déclaration acceptée (200)', dec.get('ok') is True, str(dec)[:80])
    lic = c.dev({'op': 'entitlement'})
    check('déclaration ≠ accès : toujours refusé (pending)',
          lic.get('accessAllowed') is False and lic.get('reasonCode') == 'pending', f"{lic.get('reasonCode')}")
    gate = c.app_code()
    check('l’application renvoie le client hors licence vers /subscription (307)',
          gate.startswith('307') and 'subscription' in gate, gate[:70])

    print('\nadmin — la confirmation active, lui seul :')
    admin = C('Lic Admin', email=f'licadmin-{uuid.uuid4().hex[:6]}@agence-bellamy.fr', platform=True)
    page = sh(['curl', '-s', '-L', f'{BASE}/fr/admin/licenses', '-H', f'Cookie: rros_session={admin.ck}'])
    check('la console liste la déclaration du client', c.ws in page or c.workspace_name in page)
    import re
    # The console lists EVERY tenant's declarations: pick the one belonging to
    # THIS customer's row (the row whose HTML block carries the workspace name).
    pid = None
    for block in page.split('data-testid="pending-row"')[1:]:
        if c.workspace_name in block:
            m = re.search(r'name="paymentId"[^>]*value="([0-9a-f-]{36})"', block)
            if m:
                pid = m.group(1)
                break
    if not pid:
        check('paymentId trouvé dans la rangée du client', False, f'len={len(page)}')
        FAIL += 1
        print(f'\n→ {PASS} PASS · {FAIL} FAIL')
        sys.exit(1)
    conf = admin.dev({'op': 'confirm', 'paymentId': pid})
    check('confirmation admin OK (confirmed_activated)',
          conf.get('ok') is True and conf.get('code') == 'confirmed_activated', str(conf)[:100])
    lic = c.dev({'op': 'entitlement'})
    check('accès ouvert après confirmation (active + expires_at)',
          lic.get('accessAllowed') is True and lic.get('status') == 'active' and bool(lic.get('expiresAt')),
          f"{lic.get('status')} → {str(lic.get('expiresAt'))[:10]}")
    check('l’endpoint /api/license dit la même chose (serveur)',
          json.loads(sh(['curl', '-s', f'{BASE}/api/license', '-H', f'Cookie: rros_session={c.ck}']))
          .get('access_allowed') is True)
    check('l’application s’ouvre au client licencié (200)', c.app_code().startswith('200'), c.app_code()[:40])
    again = admin.dev({'op': 'confirm', 'paymentId': pid})
    check('2ᵉ confirmation du même paiement → already_confirmed',
          again.get('ok') is False and again.get('code') == 'already_confirmed', str(again)[:80])

    print('\nrenforcement :')
    bad = c.dev({'op': 'declare', 'plan': 'growth', 'amount': 100, 'reference': f'TR-{uuid.uuid4().hex[:10]}'})
    if bad.get('ok'):
        rej = admin.dev({'op': 'confirm', 'paymentId': bad['paymentId']})
        check('montant inexact → confirmation rejetée (amount_mismatch)',
              rej.get('ok') is False and rej.get('code') == 'amount_mismatch', str(rej)[:80])
    else:
        check('déclaration à montant inexact créée', False, str(bad)[:80])

    susp = admin.dev({'op': 'suspend', 'workspaceId': c.ws})
    lic = c.dev({'op': 'entitlement'})
    check('suspension → accès coupé (suspended)',
          susp.get('ok') is True and lic.get('accessAllowed') is False and lic.get('reasonCode') == 'suspended',
          f"{lic.get('reasonCode')}")
    rea = admin.dev({'op': 'reactivate', 'workspaceId': c.ws, 'months': 0})
    lic = c.dev({'op': 'entitlement'})
    check('réactivation (mois 0, période inchangée) → accès rendu',
          rea.get('ok') is True and lic.get('accessAllowed') is True, f"{lic.get('status')}")

    print(f'\n→ {PASS} PASS · {FAIL} FAIL')
    sys.exit(1 if FAIL else 0)


if __name__ == '__main__':
    main()
