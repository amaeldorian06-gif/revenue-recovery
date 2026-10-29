import { chromium } from 'playwright';
const BASE = 'http://localhost:3000';
const mode = process.argv[2] ?? 'honest';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1320, height: 1200 }, locale: 'fr-FR' });
const page = await ctx.newPage();
await ctx.request.post(`${BASE}/api/dev/seed`, { data: { email: `res${Date.now()}@studio-merlot.fr`, workspace: 'Studio Merlot' } });
const params = mode === 'effect'
  ? { weeks: 12, perWeek: 260, lift: 1.2, seed: 11 }
  : { weeks: 12, perWeek: 34, lift: 0.35, seed: 3 };
const r = await ctx.request.post(`${BASE}/api/dev/measure`, { data: params });
console.log(mode, '→', (await r.text()).slice(0, 120));
await page.goto(`${BASE}/fr/results`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-testid="headline"]');
console.log('état →', await page.getAttribute('[data-testid="headline"]', 'data-state'));
console.log('phrase →', (await page.getByTestId('headline').innerText()).replace(/\n+/g, ' ').slice(0, 200));
await page.waitForTimeout(400);
await page.screenshot({ path: `tools/results_${mode}.png`, fullPage: true });
await browser.close();
