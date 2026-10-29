/**
 * Live proof of the PASSWORDLESS flow — through the REAL UI, in dev mode
 * (next dev exposes the dev_token link by design; production hides it):
 * signup → signout → login → the magic link arrives → opening it opens a
 * revocable session → REPLAYING the same link is refused (single use) →
 * the 5-strikes rate limit closes the door.
 * Usage (from apps/web, so dev gets its OWN dist dir and never clobbers the
 * production build in .next):
 *   NEXT_DEV_DIST=1 npx next dev -p 3001
 * then: node tools/magic_link_live.mjs
 * NOTE: after the walk, rebuild production (`npm run build`) if it was wiped.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3001';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
const page = await ctx.newPage();
const email = `magique-${Date.now()}@cabinet-live.fr`;

// 1. Real signup → session.
await page.goto(`${BASE}/fr/signup`, { waitUntil: 'load', timeout: 240_000 });
await page.fill('#email', email);
await page.fill('#workspace', 'Cabinet Live');
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.click('button[type="submit"]');
try {
  await page.waitForURL(/onboarding|\/fr\/?$/, { timeout: 360_000 });
  check('inscription réelle → session ouverte', true, page.url());
} catch {
  await page.screenshot({ path: '/tmp/ml_signup.png', fullPage: true });
  console.log('[debug] url après submit:', page.url());
  const body = await page.locator('body').innerText();
  console.log('[debug] body:', body.slice(0, 300));
  throw new Error('signup nav timeout');
}

// 2. Sign out through the real button.
await page.goto(`${BASE}/fr/pipeline`, { waitUntil: 'load', timeout: 240_000 });
await page.click('form[action]:has(input[name="locale"]) button');
await page.waitForURL(/\/login/, { timeout: 120_000 });
check('déconnexion UI → login', true);

// 3. Request the magic link for the EXISTING account.
await page.fill('#email', email);
await page.click('button[type="submit"]');
await page.waitForURL(/sent=1/, { timeout: 120_000 });
const devLink = await page.locator('[data-testid="magic-dev-link"]').getAttribute('href');
check('lien magique émis (dev_token visible en dev)', Boolean(devLink && devLink.includes('token=')));

// 4. Opening the link opens the app.
await page.goto(`${BASE}${devLink}`, { waitUntil: 'load', timeout: 240_000 });
const opened = !page.url().includes('/login');
check('ouverture du lien → session réelle, app ouverte', opened, page.url());

// 5. REPLAY the same link → single use enforced.
const replay = await ctx.newPage();
await replay.goto(`${BASE}${devLink}`, { waitUntil: 'load', timeout: 240_000 });
check('REJEU du même lien refusé (usage unique)',
  replay.url().includes('link_invalid'), replay.url());

// 6. Rate limit: 5 unknown-email attempts close the door for this IP.
const ip = await ctx.newPage();
await ip.goto(`${BASE}/fr/login`, { waitUntil: 'load', timeout: 240_000 });
let rateLimited = false;
for (let i = 0; i < 6; i += 1) {
  await ip.fill('#email', `inconnu-${i}@nullepart.fr`);
  await ip.click('button[type="submit"]');
  await page.waitForTimeout(400);
  const body = await ip.locator('body').innerText();
  if (/rate_limited|tentatives/i.test(body)) { rateLimited = true; break; }
  await ip.goto(`${BASE}/fr/login`, { waitUntil: 'load' });
}
check('5 échecs → 6ᵉ tentative bloquée (rate limit IP)', rateLimited);

await browser.close();
const pass = results.filter(Boolean).length;
console.log(`\n→ ${pass}/${results.length} vérifications`);
process.exit(pass === results.length ? 0 : 1);
