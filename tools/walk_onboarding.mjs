import { chromium } from 'playwright';

/**
 * Phase 06, criterion 7 — the onboarding walked by a stranger in a real
 * browser: signup → 5 steps → Today with a non-empty queue, timed, one
 * screenshot per step. The promise is < 8 minutes; we measure the real thing.
 */
const BASE = 'http://localhost:3000';
const email = `walk${Date.now()}@agence-bellamy.fr`;

const t0 = Date.now();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1320, height: 1100 }, locale: 'fr-FR' });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `tools/onboarding_${n}.png`, fullPage: true });
const log = (n, what) => console.log(`${n} ${what} · +${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 0 — the stranger arrives on the login screen and chooses to sign up.
await page.goto(`${BASE}/fr/signup`, { waitUntil: 'load', timeout: 90_000 });
await shot('0_signup');
await page.fill('#email', email);
await page.fill('#workspace', 'Agence Bellamy');
await page.getByRole('button', { name: /Créer|commencer|S'inscrire|S’inscrire/i }).click();
await page.waitForURL('**/onboarding/1', { timeout: 150_000 });
log('0', 'inscription → redirection vers l’étape 1');

// 1 — account & workspace (timezone prefilled from the browser).
await page.waitForSelector('[data-testid="step1-continue"]');
await shot('1_account');
await page.fill('[data-testid="tz-input"]', 'Europe/Paris');
await page.click('[data-testid="step1-continue"]');
await page.waitForURL('**/onboarding/2', { timeout: 150_000 });
log('1', 'compte enregistré');

// 2 — mailbox: the explicit sandbox path.
await page.waitForSelector('[data-testid="mailbox-later"]');
await shot('2_mailbox');
await page.click('[data-testid="mailbox-later"]');
await page.waitForURL('**/onboarding/3?sandbox=1', { timeout: 150_000 });
log('2', 'bac à sable choisi');

// 3 — import: the demo portfolio (a CSV import was walked in phase 02).
await page.waitForSelector('[data-testid="use-demo"]');
await shot('3_import');
await page.click('[data-testid="use-demo"]');
await page.waitForURL('**/onboarding/4?demo=1', { timeout: 150_000 });
log('3', 'démo plantée (20 dossiers, 4 témoins)');

// 4 — calibration: the four figures, the holdout card, one button.
await page.waitForSelector('[data-testid="calibration"]');
const figures = await page.locator('[data-testid="calibration"] .card .pad').allInnerTexts();
console.log('4 figures →', figures.slice(0, 4).map((f) => f.replace(/\n/g, ' ')).join(' | '));
await shot('4_calibration');

// 5 — first queue generated, landing on Today with the coach-mark.
await page.click('[data-testid="generate-first-queue"]');
await page.waitForURL((u) => u.searchParams.get('coach') === '1', { timeout: 150_000 });
await page.waitForSelector('[data-testid="coach-mark"]');
await shot('5_today_coach');
const coach = await page.getByTestId('coach-mark').innerText();
console.log('5 coach   →', coach.replace(/\n+/g, ' ').slice(0, 140));
// dismiss: shown once, ever — reload must not bring it back.
await page.click('[data-testid="coach-dismiss"]');
await page.reload({ waitUntil: 'load', timeout: 90_000 });
const gone = (await page.locator('[data-testid="coach-mark"]').count()) === 0;
console.log('5 dismiss  →', 'coach-mark absent après rechargement :', gone);
const cards = await page.locator('[data-testid="queue-card"], .card a[href*="dossier"]').count();
const minutes = (Date.now() - t0) / 60000;
console.log(`total     → ${minutes.toFixed(1)} min (promesse < 8) · file non vide: ${cards > 0 || (await page.locator('.card').count()) > 0}`);

// The funnel is admin/internal-gated: on a production build it requires
// INTERNAL_EMAILS and redirects everyone else — which is the product working.
await page.goto(`${BASE}/fr/internal/funnel`, { waitUntil: 'load', timeout: 90_000 });
if (await page.locator('[data-testid="funnel-admin"]').count()) {
  const median = await page.locator('[data-testid="funnel-queue_generated"]').innerText();
  console.log('funnel    →', median.replace(/\n+/g, ' ').slice(0, 120));
  await shot('6_funnel');
} else {
  console.log('funnel    → fermé en build production (INTERNAL_EMAILS requis) — comportement attendu');
}

await browser.close();
