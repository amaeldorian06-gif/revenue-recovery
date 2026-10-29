import { chromium } from 'playwright';
const BASE = 'http://localhost:3000';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1320, height: 980 }, locale: 'fr-FR' });
const page = await ctx.newPage();
await ctx.request.post(`${BASE}/api/dev/seed`, { data: { email: `card${Date.now()}@studio-merlot.fr`, workspace: 'Studio Merlot' } });
await page.goto(`${BASE}/fr/import`);
await page.setInputFiles('input[type=file]', 'data/exemple_pipeline.csv');
await page.getByRole('button', { name: /Analyser le fichier/i }).click();
await page.waitForURL(/mapping/);
await page.getByRole('button', { name: /Vérifier les données/i }).click();
await page.waitForURL(/report/);
await page.getByRole('button', { name: /^Importer \d+ ligne/i }).click();
await page.waitForURL(/calibration/);
await page.goto(`${BASE}/fr`);
await page.waitForSelector('[aria-label^="Priorité"]');
await page.waitForLoadState('networkidle');
await page.getByRole('button', { name: 'Ouvrir', exact: true }).first().click();
await page.locator('[data-testid="open-card"]').first().click();
await page.waitForURL(/\/fr\/queue\/[0-9a-f-]{36}$/);
await page.locator('[data-testid="draft-body"]').waitFor();
// petite modification pour montrer la ligne « message modifié ». On passe par le
// setter natif + un évènement input : un fill() de Playwright sur un textarea
// contrôlé peut doubler la valeur, ce qui fausserait la capture.
const box = page.locator('[data-testid="draft-body"]');
const value = await box.inputValue();
const edited = value.replace(/\n\nBien à vous,/, '\n\nJe peux vous appeler si c’est plus simple.\n\nBien à vous,');
await box.evaluate((el, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.scrollTop = 0;
  el.setSelectionRange(0, 0);
}, edited);
await page.waitForTimeout(600);
console.log('compteur →', await page.getByTestId('word-count').innerText());
await page.screenshot({ path: 'tools/card_editor.png', fullPage: true });
await page.getByTestId('approve').click();
await page.getByTestId('toast').waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/card_approved.png' });
await browser.close();
