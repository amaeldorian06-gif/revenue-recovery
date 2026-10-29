"""Prépare un espace + un portefeuille, et imprime le cookie de session et le
premier dossier de la file. Utilisé par tools/timing_approve.mjs (Playwright)."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flow_send as F  # noqa: E402  (le module ne s'exécute plus à l'import)

F.seed()
F.import_csv()
queue = json.loads(F.get('/api/queue'))
item = queue['items'][0]
json.dump(
    {
        'cookie': F.CK,
        'opportunityId': item['opportunityId'],
        'clientName': item['clientName'],
        'queueSize': len(queue['items']),
    },
    sys.stdout,
)
