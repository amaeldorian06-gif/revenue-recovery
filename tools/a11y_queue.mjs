/**
 * Criterion 10 — the keyboard and the announcement, tested in a real browser
 * rather than asserted in prose. Runs against the dev server with a seeded
 * workspace, imports the sample CSV, then drives the Today screen.
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

// 1. session
await ctx.request.post(`${BASE}/api/dev/seed`, {
  data: { email: `a11y${Date.now()}@studio.fr`, workspace: 'A11y Studio' },
});

// 2. import du fichier d'exemple via l'écran d'import
await page.goto(`${BASE}/fr/import`);
await page.setInputFiles('input[type=file]', 'data/exemple_pipeline.csv');
await page.getByRole('button', { name: /Analyser le fichier/i }).click();
await page.waitForURL(/\/import\/[0-9a-f-]+\/mapping/);
await page.getByRole('button', { name: /Vérifier les données/i }).click();
await page.waitForURL(/\/report/);
await page.getByRole('button', { name: /^Importer \d+ ligne/i }).click();
await page.waitForURL(/\/calibration/);

// 3. Today
await page.goto(`${BASE}/fr`);
await page.waitForSelector('[aria-label^="Priorité"]');
const cards = await page.locator('ol[aria-label^="File du jour"] > li').count();
check('la file affiche des cartes', cards > 0, `${cards} cartes`);

// 4. j / k déplacent le curseur
const outlineOf = async (i) =>
  page.locator('ol[aria-label^="File du jour"] > li').nth(i).evaluate((el) => getComputedStyle(el).outlineStyle + '|' + getComputedStyle(el).outlineWidth);
const firstBefore = await outlineOf(0);
await page.keyboard.press('j');
const secondAfter = await outlineOf(1);
check('j déplace le curseur sur la carte 2', secondAfter.startsWith('solid'), secondAfter);
check('le focus visible suit (contour)', firstBefore.startsWith('solid'), firstBefore);

await page.keyboard.press('k');
check('k ramène le curseur sur la carte 1', (await outlineOf(0)).startsWith('solid'));

// 5. Entrée ouvre, la formule apparaît, Échap ferme
await page.keyboard.press('Enter');
const formula = page.locator('pre', { hasText: 'valeur attendue' });
await formula.waitFor({ timeout: 5000 });
const formulaText = await formula.innerText();
check('Entrée ouvre la carte et montre la multiplication', /valeur attendue = .*= .*€/.test(formulaText), formulaText.split('\n')[0]);
check('la seconde ligne montre la priorité', /priorité = valeur attendue × urgence/.test(formulaText), formulaText.split('\n')[1]);

const described = await page.getByRole('list').first().getAttribute('aria-label');
check('la liste est nommée pour les lecteurs d’écran', Boolean(described), described ?? '');

const live = await page.getByTestId('queue-live').innerText().catch(() => '');
check('aria-live annonce l’ouverture', /Détail ouvert/.test(live), live);

await page.keyboard.press('Escape');
await formula.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
check('Échap referme la carte', (await page.locator('pre', { hasText: 'valeur attendue' }).count()) === 0);

// 6. priorité lisible et jamais le score en euros
const firstCard = await page.locator('ol[aria-label^="File du jour"] > li').first().innerText();
check('la carte affiche une priorité 0–100', /^\d{1,3}\n/.test(firstCard) || /(^|\n)(100|\d{1,2})(\n| )/.test(firstCard), firstCard.split('\n')[0]);
check('aucun score brut en euros sur la carte repliée', !/€\s*×|score \d{3,}/.test(firstCard));

await page.screenshot({ path: 'tools/today.png', fullPage: false });
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} vérifications passent`);
process.exit(failed.length === 0 ? 0 : 1);
