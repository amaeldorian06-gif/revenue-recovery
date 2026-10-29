/**
 * Walk UI de la page AR — REAL browser against :3000 (prod build):
 * signup → seeded créances in PG → /fr/ar (KPIs, tableau dense, badge
 * priorité, <details> traçable vers /fr/pipeline/<id>, vues = règles) →
 * /en/ar (i18n) → captures. Usage : node tools/ar_page_walk.mjs
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
const ctx = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
const page = await ctx.newPage();
const email = `ar-walk-${Date.now()}@cabinet-live.fr`;

// 1. Signup réel.
await page.goto(`${BASE}/fr/signup`, { waitUntil: 'load', timeout: 240_000 });
await page.fill('#email', email);
await page.fill('#workspace', 'Cabinet Marchal');
await page.click('button[type="submit"]');
await page.waitForURL(/onboarding|\/fr\/?$/, { timeout: 360_000 });
const ws = (await pgc.query(`select workspace_id::text as ws from users where email = $1::text`, [email])).rows[0].ws;
check('signup réel → app ouverte', true, ws);

// 2. Créances réalistes + un signal d'ouverture (facteur "opens" du moteur).
const inserted = await pgc.query(
  `insert into opportunities (workspace_id, external_ref, client_name, amount_cents, sent_at, status, arm, source, title)
   values ($1::uuid,'w1','Atelier Verne',100000::bigint,$2::timestamptz,'open','treatment','import','Charte graphique'),
          ($1::uuid,'w2','Cabinet Lorin',450000::bigint,$3::timestamptz,'open','treatment','import','Audit conformité RGPD'),
          ($1::uuid,'w3','Delta Fermé',900000::bigint,$4::timestamptz,'won','treatment','import',null)
   returning id::text as id, client_name`,
  [ws, iso(10), iso(95), iso(12)],
);
const verne = inserted.rows.find((r) => r.client_name === 'Atelier Verne');
await pgc.query(
  `insert into signal_events (workspace_id, opportunity_id, kind, occurred_at, source)
   values ($1::uuid, $2::uuid, 'email_open', $3::timestamptz, 'live_walk'), ($1::uuid, $2::uuid, 'email_open', $4::timestamptz, 'live_walk')`,
  [ws, verne.id, iso(2), iso(1)],
);

// 3. Page FR.
await page.goto(`${BASE}/fr/ar`, { waitUntil: 'load', timeout: 240_000 });
await page.waitForSelector('[data-testid="ar-page"]', { timeout: 60_000 });
check('onglet « Créances » visible dans la nav', await page.locator('a[href="/fr/ar"]').count() > 0);
check('KPI encours = 5 500 €', (await page.locator('[data-testid="kpi-outstanding"]').innerText()).replace(/\D/g, '') === '5500',
  await page.locator('[data-testid="kpi-outstanding"]').innerText());
check('KPI échu = 4 500 € (seule la ligne à 95 j)', (await page.locator('[data-testid="kpi-overdue"]').innerText()).replace(/\D/g, '') === '4500');
check('KPI DSO = données insuffisantes', (await page.locator('[data-testid="kpi-dso"]').innerText()).match(/[Dd]onnées insuffisantes/) !== null);
check('Delta Fermé absent du tableau (won ≠ encours)', (await page.locator('[data-testid="ar-row"]').count()) === 2);
check('libellé « ancienneté », jamais « retard » seul', (await page.locator('[data-testid="ar-page"]').innerText()).includes('ancienneté'));

// 4. Badge priorité + facteurs d'explication (ouvertures → facteur opens).
const verneRow = page.locator('tr', { has: page.locator('text=Atelier Verne') });
const badge = await verneRow.locator('[data-testid^="ar-priority-"]').innerText();
check('badge priorité avec libellé + indice 0-100 (couleur jamais seule)', /Priorité/.test(badge) && /^Priorité (haute|Moyenne|Faible|moyenne|faible) · \d{1,3}$/.test(badge.trim()), badge);
check('facteur "opens" visible (2 ouvertures seedées)', /ouvert 2 fois ces 14 derniers jours/.test(await verneRow.innerText()),
  (await verneRow.innerText()).slice(0, 160));

// 5. <details> → traçabilité vers le dossier pipeline existant.
const href = await verneRow.locator('details a[href^="/fr/pipeline/"]').first().getAttribute('href');
check('ligne de créance tracée vers /fr/pipeline/<id>', /^\/fr\/pipeline\/[0-9a-f-]{36}$/.test(href ?? ''), href ?? 'aucun');

// 6. Vue = règle métier, synchronisée URL.
await page.click('[data-testid="ar-view-priority_high"]');
await page.waitForURL(/view=priority_high/, { timeout: 30_000 });
const rowsHigh = await page.locator('[data-testid="ar-row"]').count();
check('vue « Priorité haute » → URL + filtre serveur', page.url().includes('view=priority_high') && rowsHigh >= 1, `rows=${rowsHigh}`);
await page.screenshot({ path: 'screenshots/ar_fr.png', fullPage: true });

// 7. Recherche serveur (GET form) : reset puis q=lorin.
await page.click('[data-testid="ar-reset"]');
await page.waitForSelector('[data-testid="ar-q"]');
await page.fill('[data-testid="ar-q"]', 'lorin');
await page.click('[data-testid="ar-apply"]');
await page.waitForURL(/q=lorin/, { timeout: 30_000 });
check('recherche q=lorin → 1 ligne, KPIs inchangés',
  (await page.locator('[data-testid="ar-row"]').count()) === 1
  && (await page.locator('[data-testid="kpi-outstanding"]').innerText()).replace(/\D/g, '') === '5500');

// 8. EN — i18n.
await page.goto(`${BASE}/en/ar`, { waitUntil: 'load', timeout: 240_000 });
await page.waitForSelector('[data-testid="ar-page"]');
const enText = await page.locator('[data-testid="ar-page"]').innerText();
check('EN : DSO "Not enough data"', /Not enough data/.test(enText));
check('EN : plus de « échu » français', !enText.includes('échu'));
await page.screenshot({ path: 'screenshots/ar_en.png', fullPage: true });

await browser.close();
await pgc.end();
const ok = results.every(Boolean);
console.log(ok ? `\nAR page walk : ${results.filter(Boolean).length}/${results.length} ✓` : '\nÉCHEC — voir ×');
process.exit(ok ? 0 : 1);
