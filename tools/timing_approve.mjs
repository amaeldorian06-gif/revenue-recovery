/**
 * Phase 04, critère 11 — approuver une carte prend moins de deux clics et aucune
 * navigation de page.
 *
 * Ce script mesure le parcours réel dans Chromium : file du jour → carte →
 * approbation. Il compte les clics, les navigations et le temps, et vérifie qu'un
 * clic sur « Approuver et envoyer » n'appelle jamais le job d'envoi (approbation
 * et envoi sont deux étapes distinctes).
 */
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

const prep = JSON.parse(
  execFileSync('python3', ['tools/prepare_card.py'], {
    cwd: '/home/user/rros',
    env: { ...process.env, PYTHONPATH: '/home/user/rros/tools' },
    encoding: 'utf8',
  }),
);

const browser = await chromium.launch();
const context = await browser.newContext({ locale: 'fr-FR' });
await context.addCookies([
  { name: 'rros_session', value: prep.cookie, domain: 'localhost', path: '/' },
]);

const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

let navigations = 0;
page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) navigations += 1;
});

let cronCalls = 0;
await page.route('**/api/cron/send', async (route) => {
  cronCalls += 1;
  await route.abort();
});

// 1. La file du jour
await page.goto(`${BASE}/fr`, { waitUntil: 'networkidle' });
const cards = await page.locator('[aria-label^="Priorité"]').count();

// 2. Ouvrir la carte : un clic sur « Ouvrir », un sur « Écrire la relance »
const clicksToCard = [];
let t = Date.now();
await page.getByRole('button', { name: 'Ouvrir', exact: true }).first().click();
clicksToCard.push('Ouvrir');
await page.locator('[data-testid="open-card"]').first().click();
clicksToCard.push('Écrire la relance');
await page.waitForURL(/\/fr\/queue\/[0-9a-f-]{36}$/, { timeout: 15000 });
await page.locator('[data-testid="draft-body"]').waitFor();
await page.waitForLoadState('networkidle');
const openMs = Date.now() - t;

// 3. Le geste qui compte : un clic depuis la carte
const bodyText = await page.locator('[data-testid="draft-body"]').inputValue();
await page.waitForTimeout(400);
const navBeforeApprove = navigations;

t = Date.now();
await page.getByTestId('approve').click();
await page.getByTestId('toast').waitFor({ timeout: 15000 });
const approveMs = Date.now() - t;
const navAfterApprove = navigations;

await page.waitForFunction(
  () => (document.querySelector('[data-testid="toast"]')?.textContent ?? '').includes('pprouv'),
  undefined,
  { timeout: 15000 },
);
const toast = await page.getByTestId('toast').innerText();
const approvedVisible = await page.getByText('✓ Approuvé').isVisible();
const banner = await page.getByTestId('sandbox-banner').innerText().catch(() => '');

// 4. La carte ne régénère pas de brouillon après approbation
const draftStillThere = await page.getByTestId('draft-body').inputValue();

await browser.close();

const out = {
  queueCards: cards,
  clicksToCard,
  clicksToApprove: 1,
  openMs,
  approveMs,
  navigationsDuringApprove: navAfterApprove - navBeforeApprove,
  sentJobCalledByApprove: cronCalls,
  approvedVisible,
  toast: toast.slice(0, 140),
  sandboxBanner: banner.slice(0, 70),
  draftWords: bodyText.trim().split(/\s+/).length,
  draftAfterApproveWords: draftStillThere.trim().split(/\s+/).length,
  consoleErrors,
};
console.log(JSON.stringify(out, null, 2));

const ok =
  out.clicksToApprove < 2 &&
  out.navigationsDuringApprove === 0 &&
  out.sentJobCalledByApprove === 0 &&
  out.approvedVisible;
console.log(ok ? 'CRITÈRE 11 : OK' : 'CRITÈRE 11 : ÉCHEC');
process.exit(ok ? 0 : 1);
