/**
 * Live proof of session revocation (migration 0010) — through the REAL UI:
 * 1. signup → session émise, l'app s'ouvre ;
 * 2. le cookie est « volé » (copié dans un autre navigateur) : il fonctionne —
 *    c'est exactement le risque ;
 * 3. déconnexion par l'UI réelle (signoutAction → revokeSession) ;
 * 4. le cookie volé, rejoué depuis le second navigateur, est REFUSÉ : la
 *    révocation est un fait serveur, plus une expiration passive.
 * Runs against the production server (RROS_DEV_SEED=1).
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
const victim = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
const page = await victim.newPage();

// 1. Real signup, real session.
await page.goto(`${BASE}/fr/signup`, { waitUntil: 'load', timeout: 60_000 });
await page.fill('#email', `revoc-${Date.now()}@agence-sessions.fr`);
await page.fill('#workspace', 'Agence Révocation');
await page.click('button[type="submit"]');
await page.waitForURL(/\/fr\/(onboarding|$)/, { timeout: 60_000 });
const cookies = await victim.cookies();
const session = cookies.find((c) => c.name === 'rros_session');
check('session émise par le parcours réel (cookie httpOnly)', Boolean(session));

await page.goto(`${BASE}/fr/pipeline`, { waitUntil: 'load' });
check('l’application s’ouvre avec la session valide', !page.url().includes('/login'));

// 2. The cookie is stolen: replayed from ANOTHER browser.
const thief = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
await thief.addCookies([{ name: session.name, value: session.value, domain: 'localhost', path: '/' }]);
const thiefPage = await thief.newPage();
await thiefPage.goto(`${BASE}/fr/pipeline`, { waitUntil: 'load' });
check('le cookie volé fonctionne avant révocation (le risque visé)', !thiefPage.url().includes('/login'));

// 3. The victim signs out through the REAL button (revoke + destroy).
await page.goto(`${BASE}/fr/pipeline`, { waitUntil: 'load' });
await page.click('form[action]:has(input[name="locale"]) button');
await page.waitForURL(/\/login/, { timeout: 30_000 });
check('déconnexion UI → redirection login', page.url().includes('/login'));

// 4. The STOLEN cookie, replayed AFTER revocation, is refused.
await thiefPage.goto(`${BASE}/fr/pipeline`, { waitUntil: 'load' });
check('après signout, le même cookie volé est REFUSÉ (révocation serveur)',
  thiefPage.url().includes('/login'), thiefPage.url());

// 5. The victim is also out (their cookie was destroyed AND the row revoked).
await page.goto(`${BASE}/fr/pipeline`, { waitUntil: 'load' });
check('la victime aussi est dehors (row révoquée, pas seulement le cookie)',
  page.url().includes('/login'));

await browser.close();
const pass = results.filter(Boolean).length;
console.log(`\n→ ${pass}/${results.length} vérifications`);
process.exit(pass === results.length ? 0 : 1);
