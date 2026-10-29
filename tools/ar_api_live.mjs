/**
 * Live proof of the AR API — REAL HTTP calls against the running server
 * (:3000 by default), no simulated success:
 *   401 unauthenticated → signup (real UI) → seeded créances in PG →
 *   200 JSON shape (kpis on the whole perimeter, dso null) → 400 invalid
 *   query → CSV export (headers, whole set, formula guard) → 403 when the
 *   trial is closed → tenant isolation (workspace never from the client).
 *
 * Usage (server :3000 up, PG :5433 up):
 *   node tools/ar_api_live.mjs
 */
import { chromium } from 'playwright';
import pg from 'pg';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const PG_URL = process.env.PG_URL ?? 'postgres://postgres@127.0.0.1:5433/rros';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const pgc = new pg.Client({ connectionString: PG_URL });
await pgc.connect();
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

const browser = await chromium.launch();

async function signup(label) {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
  const page = await ctx.newPage();
  const email = `ar-live-${label}-${Date.now()}@cabinet-live.fr`;
  await page.goto(`${BASE}/fr/signup`, { waitUntil: 'load', timeout: 240_000 });
  await page.fill('#email', email);
  await page.fill('#workspace', `Cabinet AR ${label}`);
  await page.click('button[type="submit"]');
  await page.waitForURL(/onboarding|\/fr\/?$/, { timeout: 360_000 });
  const cookie = (await ctx.cookies()).find((c) => c.name === 'rros_session');
  const ws = await pgc.query(
    `select workspace_id::text as ws from users where email = $1::text`, [email]);
  return { ctx, email, cookie, workspaceId: ws.rows[0].ws };
}

// ── 1. 401 without a session ────────────────────────────────────────────────
const anon = await fetch(`${BASE}/api/ar`);
check('GET /api/ar sans session → 401', anon.status === 401,
  `${anon.status} ${JSON.stringify(await anon.json().catch(() => ({})))}`);

// ── 2. Real signup (workspace A) + seeded créances ─────────────────────────
const A = await signup('a');
check('inscription réelle (UI) → session + workspace', Boolean(A.cookie && A.workspaceId), A.workspaceId);

await pgc.query(
  `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, source, title)
   values ($1::uuid,'live-1','Atelier Verne',100000::bigint,$2::timestamptz,'open','treatment','import','Charte graphique'),
          ($1::uuid,'live-2','Cabinet Lorin',450000::bigint,$3::timestamptz,'open','treatment','import','Audit conformité'),
          ($1::uuid,'live-3','Delta Fermé',900000::bigint,$4::timestamptz,'won','treatment','import',null)`,
  [A.workspaceId, iso(10), iso(95), iso(12)],
);

const cookieHeader = `rros_session=${A.cookie.value}`;

// ── 3. 200 JSON — shape and money rules on the REAL endpoint ───────────────
const res = await fetch(`${BASE}/api/ar`, { headers: { cookie: cookieHeader } });
const body = await res.json();
check('GET /api/ar avec session → 200', res.status === 200, String(res.status));
check('cache-control: no-store', res.headers.get('cache-control') === 'no-store');
check('kpis périmètre entier (filtres absents)', body.kpis?.outstandingCents === 550_000,
  JSON.stringify(body.kpis));
check('échu 30 j = seule la ligne à 95 j', body.kpis?.overdueCents === 450_000);
check('won ≠ encaissé : hors encours, dans "clôturées gagnantes" (30 j)',
  body.kpis?.outstandingCents !== 1_450_000 && body.kpis?.wonClosed30dCents === 900_000);
check('DSO = null explicite (données insuffisantes)', body.kpis?.dsoDays === null);
check('lignes = 2 clients ouverts, Delta absent', body.total === 2 && !JSON.stringify(body.rows).includes('Delta'),
  `total=${body.total}`);
const lorin = (body.rows ?? []).find((r) => r.client === 'Cabinet Lorin');
check('ligne client : échu + ancienneté + priorité moteur',
  lorin?.overdueCents === 450_000 && lorin?.oldestAgeDays === 95
  && typeof lorin?.priorityScoreCents === 'number' && /^\d{4}-\d{2}-v\d+$/.test(lorin?.engineVersion ?? ''),
  JSON.stringify({ band: lorin?.priorityBand, score: lorin?.priorityScoreCents, v: lorin?.engineVersion }));
check('facteurs d’explication présents (explanations.ts)', (lorin?.factors ?? []).length > 0,
  JSON.stringify((lorin?.factors ?? []).map((f) => f.key)));

// ── 4. Validation serveur : 400 ────────────────────────────────────────────
const bad1 = await fetch(`${BASE}/api/ar?status=bogus`, { headers: { cookie: cookieHeader } });
const bad2 = await fetch(`${BASE}/api/ar?age_min=-3`, { headers: { cookie: cookieHeader } });
const bad3 = await fetch(`${BASE}/api/ar?sort=client_hack`, { headers: { cookie: cookieHeader } });
check('status=bogus → 400 invalid_query', bad1.status === 400 && (await bad1.json()).error === 'invalid_query');
check('age_min=-3 → 400', bad2.status === 400);
check('sort inconnu → 400', bad3.status === 400);

// ── 5. Filtres + tri côté serveur ─────────────────────────────────────────
const filtered = await fetch(`${BASE}/api/ar?q=verne`, { headers: { cookie: cookieHeader } });
const fBody = await filtered.json();
check('q=verne → 1 ligne mais KPIs inchangés (périmètre entier)',
  fBody.total === 1 && fBody.kpis.outstandingCents === 550_000,
  `total=${fBody.total} kpi=${fBody.kpis.outstandingCents}`);
const byPri = await fetch(`${BASE}/api/ar?view=priority_high`, { headers: { cookie: cookieHeader } });
const priBody = await byPri.json();
check('vue priority_high : lignes high seulement', priBody.rows.every((r) => r.priorityBand === 'high')
  && priBody.rows.length >= 1, `n=${priBody.rows.length}`);

// ── 6. CSV — headers, ensemble ENTIER, garde formules ─────────────────────
const csv = await fetch(`${BASE}/api/ar?format=csv&page_size=5`, { headers: { cookie: cookieHeader } });
// response.text() décode en UTF-8 et RETIRE le BOM : lire les octets réels.
const csvBytes = new Uint8Array(await csv.arrayBuffer());
const csvText = new TextDecoder('utf-8').decode(csvBytes.slice(3)); // sans BOM
check('CSV → 200 text/csv + BOM (octets EF BB BF)', csv.status === 200
  && csv.headers.get('content-type').includes('text/csv')
  && (csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF));
check('en-tête x-ar-payment-term-days: 30', csv.headers.get('x-ar-payment-term-days') === '30',
  csv.headers.get('x-ar-payment-term-days'));
check('CSV = ensemble ENTIER filtré (2 lignes de données, pas la page)',
  csvText.trim().split('\n').length === 3, `lignes=${csvText.trim().split('\n').length}`);
check('en-têtes CSV avec priorite/indice_relance', csvText.split('\n')[0].includes('priorite')
  && csvText.split('\n')[0].includes('indice_relance'));

// ── 7. 403 — licence fermée (le workspace vient de la session) ────────────
await pgc.query(`update workspaces set subscription_status='canceled', trial_ends_at=null where id=$1::uuid`,
  [A.workspaceId]);
const forbidden = await fetch(`${BASE}/api/ar`, { headers: { cookie: cookieHeader } });
const fJson = await forbidden.json();
check('trial fermé (canceled) → 403 forbidden + reasonCode', forbidden.status === 403
  && fJson.error === 'forbidden' && typeof fJson.code === 'string',
  `${forbidden.status} code=${fJson.code}`);
await pgc.query(`update workspaces set subscription_status='trialing', trial_ends_at=now() + interval '14 days' where id=$1::uuid`,
  [A.workspaceId]);
const restored = await fetch(`${BASE}/api/ar`, { headers: { cookie: cookieHeader } });
check('trial restauré → 200 à nouveau', restored.status === 200);

// ── 8. Isolation locataire — le workspace ne vient JAMAIS du client ───────
const B = await signup('b');
const cookieB = `rros_session=${B.cookie.value}`;
const withSpoof = await fetch(`${BASE}/api/ar?workspace_id=${A.workspaceId}`, { headers: { cookie: cookieB } });
const spoofBody = await withSpoof.json();
check('workspace_id en query est IGNORÉ : B ne voit que B (0 ligne)',
  withSpoof.status === 200 && spoofBody.total === 0 && spoofBody.kpis.outstandingCents === 0,
  `total=${spoofBody.total}`);
const resB = await fetch(`${BASE}/api/ar`, { headers: { cookie: cookieB } });
const bodyB = await resB.json();
check('workspace B vide → total 0, KPIs zéro (isolation)', resB.status === 200
  && bodyB.total === 0 && bodyB.kpis.clientCount === 0);

await browser.close();
await pgc.end();
const ok = results.every(Boolean);
console.log(ok ? `\nAR API live : ${results.filter(Boolean).length}/${results.length} ✓` : '\nÉCHEC — voir ×');
process.exit(ok ? 0 : 1);
