/**
 * Criterion 10 — axe-core on the five screens, zero critical violations.
 * Runs against the production server with a seeded workspace, injects
 * axe-core into each screen and asserts: no critical violation anywhere,
 * and prints the per-screen totals for PERF/report.
 *
 *   LD_LIBRARY_PATH=~/.cache/chrome-libs/extracted/usr/lib/x86_64-linux-gnu \
 *   node tools/a11y_axe.mjs
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3000';
const axeSource = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

// Workspace with a little data so the screens have content to render.
await ctx.request.post(`${BASE}/api/dev/seed`, {
  data: { email: `axe${Date.now()}@agence-bellamy.fr`, workspace: 'Axe Studio' },
});

const SCREENS = [
  ['/fr', 'Today (file du jour)'],
  ['/fr/pipeline', 'Pipeline'],
  ['/fr/results', 'Résultats A/B'],
  ['/fr/settings', 'Réglages'],
  ['/fr/import', 'Import CSV'],
];

let failed = false;
for (const [path, label] of SCREENS) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
  await page.evaluate(axeSource);
  const res = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      resultTypes: ['violations'],
      rules: { 'region': { enabled: false } },
    });
    return {
      violations: r.violations.map((v) => ({
        id: v.id, impact: v.impact, nodes: v.nodes.length,
        help: v.help,
      })),
      passes: r.passes.length,
    };
  });
  const critical = res.violations.filter((v) => v.impact === 'critical');
  const serious = res.violations.filter((v) => v.impact === 'serious');
  const ok = critical.length === 0;
  failed ||= !ok;
  console.log(
    `${ok ? '✓' : '×'} ${label.padEnd(24)} critical ${critical.length} · serious ${serious.length} · ` +
    `autres ${res.violations.length - critical.length - serious.length} · passes ${res.passes}`,
  );
  for (const v of res.violations) {
    console.log(`    [${v.impact}] ${v.id} ×${v.nodes} — ${v.help}`);
  }
  await page.screenshot({ path: `tools/axe_${path.replace(/[^a-z]/g, '_') || 'home'}.png` });
}

await browser.close();
console.log(failed ? '\nAXE_FAIL: violations critiques détectées' : '\nAXE_PASS: 0 violation critique sur les 5 écrans');
process.exit(failed ? 1 : 0);
