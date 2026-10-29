"""Phase 08 — mesures de charge (PERF.md).

Jeu de données : 5 000 dossiers + 60 000 signaux (via /api/dev/load-seed).
Mesures : p95 de /api/queue sur 100 appels, first paint /pipeline et /results,
concurrence 50 sessions simultanées pendant 60 s (< 1 % d'erreurs).
"""
import concurrent.futures
import json
import re
import statistics
import subprocess
import time
import uuid

BASE = 'http://localhost:3000'


def curl_time(url, cookie=None, method='GET'):
    args = ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{time_total}',
            '-X', method, url]
    if cookie:
        args.insert(2, f'-HCookie: rros_session={cookie}')
    out = subprocess.run(args, capture_output=True, text=True).stdout.strip()
    code, _, secs = out.partition(' ')
    return code, float(secs) if secs else 0.0


def main():
    import os, sys
    prod = '--prod' in sys.argv
    ck = None
    if prod:
        # Session du gros workspace préparée en dev (dataset déjà en base).
        for line in open('/tmp/load08.txt'):
            if 'rros_session' in line:
                ck = line.split('\t')[-1].strip()
        print('mode      → production (next start), dataset et sessions préchargés')
    else:
        jar = f'/tmp/perf08_{uuid.uuid4().hex[:5]}.txt'
        subprocess.run(['curl', '-s', '-c', jar, '-X', 'POST', f'{BASE}/api/dev/seed',
                        '-H', 'content-type: application/json',
                        '-d', json.dumps({'email': f'perf{uuid.uuid4().hex[:5]}@agence-bellamy.fr',
                                          'workspace': 'Charge Perf 08'})], capture_output=True)
        for line in open(jar):
            if 'rros_session' in line:
                ck = line.split('\t')[-1].strip()
        out = subprocess.run(['curl', '-s', '-m', '280', '-b', jar, '-X', 'POST',
                              f'{BASE}/api/dev/load-seed', '-H', 'content-type: application/json',
                              '-d', '{"opportunities":5000,"signals":60000,"importRows":5000}'],
                             capture_output=True, text=True).stdout
        data = json.loads(out)
        print(f"dataset   → {data['opportunities']} dossiers · {data['signals']} signaux · "
              f"seed {round((data['seededMs']['opportunities'] + data['seededMs']['signals']) / 1000, 1)} s · "
              f"import 5 000 lignes (parse+mapping+staging) {data['import']['ms']} ms")

    # Warm-up + p95 /api/queue (100 appels)
    for _ in range(3):
        curl_time(f'{BASE}/api/queue', ck)
    times = []
    codes = []
    for _ in range(100):
        code, t = curl_time(f'{BASE}/api/queue', ck)
        times.append(t * 1000)
        codes.append(code)
    times.sort()
    p50 = times[len(times) // 2]
    p95 = times[int(len(times) * 0.95) - 1]
    print(f"/api/queue → n=100 · p50 {p50:.0f} ms · p95 {p95:.0f} ms (budget 400 ms) · "
          f"erreurs {codes.count('500') + codes.count('503')}")

    # First paint /pipeline et /results (server-rendered)
    for path in ['/fr/pipeline', '/fr/results', '/fr']:
        samples = []
        for _ in range(5):
            code, t = curl_time(f'{BASE}{path}', ck)
            samples.append(t * 1000)
        samples.sort()
        print(f"{path:<10} → médiane {samples[2]:.0f} ms · min {samples[0]:.0f} ms · max {samples[-1]:.0f} ms")

    # 50 sessions simultanées, 60 s
    def worker(i):
        cookie = None
        if prod:
            for line in open(f'/tmp/perf_cookies/u{i}.txt'):
                if 'rros_session' in line:
                    cookie = line.split('\t')[-1].strip()
        else:
            j = f'/tmp/perf_w{i}.txt'
            subprocess.run(['curl', '-s', '-c', j, '-X', 'POST', f'{BASE}/api/dev/seed',
                            '-H', 'content-type: application/json',
                            '-d', json.dumps({'email': f'w{i}-{uuid.uuid4().hex[:4]}@agence-bellamy.fr',
                                              'workspace': f'Charge W{i}'})], capture_output=True)
            for line in open(j):
                if 'rros_session' in line:
                    cookie = line.split('\t')[-1].strip()
        end = time.time() + 60
        ok = err = 0
        while time.time() < end:
            code, _ = curl_time(f'{BASE}/fr', cookie)
            if code == '200':
                ok += 1
            else:
                err += 1
        return ok, err

    print('concurrence → 50 sessions × 60 s …')
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=50) as ex:
        results = list(ex.map(worker, range(50)))
    ok = sum(r[0] for r in results)
    err = sum(r[1] for r in results)
    rate = 100 * err / max(1, ok + err)
    print(f"concurrence → {ok} requêtes 200 · {err} erreurs ({rate:.2f} %, budget 1 %) · {time.time() - t0:.0f} s")


if __name__ == '__main__':
    main()
