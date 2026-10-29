/* Phase 07 — browser walk: mailbox settings, reply badge on the dossier,
 * one-click close with 10 s undo, sync-error banner in the shell. */
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3000';
const SHOTS = '/home/user/rros/docs/shots';
mkdirSync(SHOTS, { recursive: true }); // artefacts régénérables — le dossier n'est pas versionné

function api(path, body, cookie, bearer) {
  const out = execSync(
    `curl -s -m 60 ${cookie ? `-H 'Cookie: rros_session=${cookie}'` : ''}` +
    ` ${bearer ? `-H 'authorization: Bearer ${bearer}'` : ''}` +
    ` -X POST ${BASE}${path} -H 'content-type: application/json' -d '${JSON.stringify(body)}'`,
    { encoding: 'utf8' },
  );
  return JSON.parse(out || '{}');
}

const run = async () => {
  const stamp = Date.now().toString(36);
  const seed = execSync(
    `curl -s -i -m 90 -X POST ${BASE}/api/dev/seed -H 'content-type: application/json'` +
    ` -d '{"email":"walk-${stamp}@agence-bellamy.fr","workspace":"Agence Bellamy ${stamp}"}'`,
    { encoding: 'utf8' },
  );
  const cookie = (seed.match(/rros_session=([^;\s]+)/) || [])[1];
  if (!cookie) throw new Error('no session cookie');

  const setup = api('/api/dev/inbox', { action: 'setup' }, cookie);
  api('/api/dev/inbox', {
    from: 'Marie Dupont <marie.dupont@client-demo.fr>',
    headers: { 'in-reply-to': setup.replySentId },
    subject: 'Re: Devis remboursement formation',
    text: 'Bonjour, votre proposition convient parfaitement. Pouvons-nous faire le point jeudi ?',
  }, cookie);
  const synced = api(`/api/cron/sync?workspaceId=${setup.workspaceId}`, {}, null, 'local-cron-secret');
  console.log('cron sync →', JSON.stringify(synced));

  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 } });
  await page.addInitScript(() => {});
  const ctx = page.context();
  await ctx.addCookies([{ name: 'rros_session', value: cookie, url: BASE }]);

  // 1. Mailbox settings
  await page.goto(`${BASE}/fr/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="settings-page"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="mailbox-status-connected"]', { timeout: 30000 });
  console.log('settings  → boîte connectée visible :',
    await page.locator('[data-testid="mailbox-row"]').count(), 'ligne(s)');

  // 2. Dossier with a reply: badge + last messages
  await page.goto(`${BASE}/fr/queue/${setup.replyDossier}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="reply-badge"]', { timeout: 60000 });
  await page.waitForSelector('[data-testid="recent-messages"] [data-testid="snippet-in"]', { timeout: 30000 });
  console.log('dossier   → badge réponse + extraits OK');
  await page.screenshot({ path: `${SHOTS}/07_dossier_reply.png`, fullPage: true });

  // 3. One-click close + undo
  await page.click('[data-testid="mark-won"]');
  await page.waitForSelector('[data-testid="undo-toast"]', { timeout: 30000 });
  console.log('clôture   → toast Gagné + undo affiché');
  await page.screenshot({ path: `${SHOTS}/07_close_undo.png`, fullPage: true });
  await page.click('[data-testid="undo-close"]');
  await page.waitForSelector('[data-testid="close-actions"]', { timeout: 30000 });
  console.log('undo      → clôture annulée, actions de retour');
  await page.screenshot({ path: `${SHOTS}/07_undo_done.png`, fullPage: false });

  // 4. Sync-error banner in the shell — and feed the audit view first:
  // one opt-out so the settings screenshot shows real events.
  api('/api/dev/inbox', {
    from: 'Jean Martin <jean.martin@client-demo.fr>',
    headers: { 'in-reply-to': setup.optOutSentId },
    subject: 'Re: Devis remboursement formation',
    text: 'Merci de me désinscrire.',
  }, cookie);
  api(`/api/cron/sync?workspaceId=${setup.workspaceId}`, {}, null, 'local-cron-secret');
  api('/api/dev/inbox', { action: 'break' }, cookie);
  await page.goto(`${BASE}/fr`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="banner-sync-error"]', { timeout: 60000 });
  console.log('bandeau   → erreur de sync visible dans le shell');
  await page.screenshot({ path: `${SHOTS}/07_banner.png`, fullPage: false });

  // 5. Settings page shot: mailbox error + privacy audit rows
  await page.goto(`${BASE}/fr/settings`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('[data-testid="mailbox-error"]', { timeout: 30000 });
  await page.waitForSelector('[data-testid="audit-row"]', { timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/07_settings.png`, fullPage: true });
  console.log('réglages  → erreur affichée + audit',
    await page.locator('[data-testid="audit-row"]').count(), 'ligne(s)');

  await browser.close();
  console.log('WALK_SYNC_PASS');
};

run().catch((e) => { console.error('WALK_SYNC_FAIL', e.message); process.exit(1); });
