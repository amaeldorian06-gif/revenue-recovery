/**
 * Launch gate A — the five things a paying customer must do ALONE, walked as a
 * stranger on the production build: account < 60 s, mailbox choice understood,
 * a messy real-agency CSV imported with the four calibration figures, a queue
 * with a dossier whose draft is worth sending, and a results page that says
 * plainly it is too early to conclude. Plus C4: the holdout explained in one
 * sentence on the calibration screen.
 *
 *   LD_LIBRARY_PATH=~/.cache/chrome-libs/extracted/usr/lib/x86_64-linux-gnu \
 *   node tools/walk_gate.mjs
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const t0 = Date.now();
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1320, height: 1000 }, locale: 'fr-FR' });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `tools/gate_${n}.png`, fullPage: true });

// ── A1. Account + workspace, timed ─────────────────────────────────────────
await page.goto(`${BASE}/fr/signup`, { waitUntil: 'load', timeout: 90_000 });
await page.fill('#email', `stranger${Date.now()}@agence-inconnue.fr`);
await page.fill('#workspace', 'Agence Inconnue');
await page.getByRole('button', { name: /Créer|commencer|S'inscrire|S’inscrire/i }).click();
await page.waitForURL('**/onboarding/1', { timeout: 150_000 });
const signupS = (Date.now() - t0) / 1000;
check('A1 compte + espace créés seul', signupS < 60, `${signupS.toFixed(1)} s (budget 60 s)`);

// ── A2. Mailbox: sandbox chosen, the copy says what changes ───────────────
await page.click('[data-testid="step1-continue"]');
await page.waitForURL('**/onboarding/2', { timeout: 150_000 });
await shot('a2_mailbox');
const step2 = await page.locator('body').innerText();
const explains = /bac à sable|sandbox/i.test(step2) && /répond|réponses|réel|envoi|connect/i.test(step2);
check('A2 bac à sable choisi, la différence est expliquée', Boolean(explains),
      step2.includes('bac à sable') ? 'copie « bac à sable » présente' : '');
await page.click('[data-testid="mailbox-later"]');
await page.waitForURL(/onboarding\/3\?sandbox=1/, { timeout: 150_000 });

// ── A3. A messy real-agency CSV → mapping → the four calibration figures ──
await page.setInputFiles('input[type=file]', 'tools/gate_messy.csv');
await page.getByRole('button', { name: /Analyser|Vérifier/i }).first().click();
await page.waitForURL(/\/import\/[0-9a-f-]+\/mapping/, { timeout: 150_000 });
await page.getByRole('button', { name: /Vérifier|Continuer/i }).click();
await page.waitForURL(/\/(report|calibration)/, { timeout: 150_000 });
const commit = page.getByRole('button', { name: /Importer \d+ ligne/i });
if (await commit.count()) {
  await commit.click();
  await page.waitForURL(/(\/calibration|onboarding\/4)/, { timeout: 150_000 });
}
await page.waitForSelector('[data-testid="calibration"]', { timeout: 150_000 });
await shot('a3_calibration');
const calibText = await page.getByTestId('calibration').innerText();
const figures = (calibText.match(/\d+/g) ?? []).length;
check('A3 CSV salé importé · chiffres de calibration visibles', figures >= 4, `${figures} nombres à l'écran`);

// C4 — the holdout explained in one sentence on the calibration screen.
const holdoutOk = /(Pourquoi .+ dossiers ne recevront aucune action|ne recevront aucune action de notre part)/i.test(calibText);
check('C4 holdout expliqué en une phrase sur l\'écran de calibration', holdoutOk,
      holdoutOk ? calibText.split('\n').find((l) => /Pourquoi/.test(l))?.slice(0, 90) : 'absent');

// ── A4. Queue generated; open a dossier whose draft is worth sending ──────
await page.click('[data-testid="generate-first-queue"]');
await page.waitForURL((u) => u.searchParams.get('coach') === '1', { timeout: 180_000 });
await page.waitForSelector('[aria-label^="Priorité"]', { timeout: 120_000 });
await shot('a4_today');
// Open dossiers until one shows a real draft (not the manual facts skeleton a
// contactless dossier gets): 60 words of French ≈ 350+ characters.
let draftLen = 0;
const openers = await page.getByRole('button', { name: 'Ouvrir', exact: true }).count();
for (let i = 0; i < Math.min(openers, 4); i++) {
  await page.getByRole('button', { name: 'Ouvrir', exact: true }).nth(i).click();
  await page.locator('[data-testid="open-card"]').first().click();
  await page.waitForURL(/\/fr\/queue\/[0-9a-f-]{36}$/, { timeout: 120_000 });
  const box = page.locator('[data-testid="draft-body"]');
  await box.waitFor({ timeout: 120_000 });
  draftLen = (await box.inputValue()).length;
  if (draftLen >= 350) break;
  await page.goto(`${BASE}/fr`, { waitUntil: 'load', timeout: 90_000 });
  await page.waitForSelector('[aria-label^="Priorité"]', { timeout: 120_000 });
}
check('A4 dossier ouvert, brouillon digne d\'être envoyé', draftLen >= 350, `${draftLen} caractères de brouillon`);
await shot('a4_dossier');

// ── A5. Results says, in plain words, it is too early ─────────────────────
await page.goto(`${BASE}/fr/results`, { waitUntil: 'networkidle', timeout: 120_000 });
await shot('a5_results');
const resText = await page.locator('[data-testid="headline"]').innerText().catch(() => '');
const tooEarly = /conclure|en cours|encore/i.test(resText) && !/Effet mesuré/i.test(resText);
check('A5 résultats : dit en clair qu\'il est trop tôt pour conclure', tooEarly,
      resText.replace(/\n+/g, ' ').slice(0, 130));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} épreuves passent · parcours complet ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(failed.length ? 1 : 0);
