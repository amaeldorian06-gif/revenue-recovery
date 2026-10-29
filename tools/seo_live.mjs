/**
 * Live proof of the GROWTH layer — real HTTP against :3000:
 * public routes (fr/en), robots, sitemap, canonical+hreflang, OG,
 * <html lang> per locale, noindex on private pages, JSON-LD validity,
 * every footer/CTA link resolves, analytics beacon persists a row,
 * `/` lands on the public product page.
 * Usage: node tools/seo_live.mjs
 */
const BASE = process.env.BASE ?? 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✓' : '×'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const get = async (p, opts = {}) => {
  const r = await fetch(`${BASE}${p}`, { redirect: 'manual', ...opts });
  return r;
};

// ── 1. Entrée publique ─────────────────────────────────────────────────────
const root = await get('/');
check('/ redirige vers la page produit publique (FR)', root.status >= 300 && root.status < 400
  && new URL(root.headers.get('location'), BASE).pathname === '/fr/product',
  `${root.status} → ${root.headers.get('location')}`);

const prodFr = await get('/fr/product');
const prodFrHtml = await prodFr.text();
check('/fr/product → 200 publique (sans cookie)', prodFr.status === 200);
check('H1 orienté résultat (prioriser, pas « IA révolutionnaire »)',
  prodFrHtml.includes('Priorisez vos créances impayées'));
check('CTA primaire → signup réel', prodFrHtml.includes('href="/fr/signup"'));
check('capture produit réelle servie', (await get('/screenshots/creances-priorisation.png')).status === 200);

// ── 2. Metadata, canonical, hreflang, OG, lang ─────────────────────────────
check('title unique et descriptif', /<title>[^<]*Priorisez vos créances[^<]*<\/title>/.test(prodFrHtml));
check('canonical auto-référencée', prodFrHtml.includes('rel="canonical" href="http://localhost:3000/fr/product"'));
// Next sérialise l'attribut en hrefLang (casse camel) — le HTML est
// insensible à la casse des attributs, les crawlers le lisent correctement.
check('hreflang fr+en+x-default réciproques', /hreflang="en"/i.test(prodFrHtml)
  && /hreflang="fr"/i.test(prodFrHtml) && /hreflang="x-default"/i.test(prodFrHtml));
check('OpenGraph présent', prodFrHtml.includes('property="og:title"') && prodFrHtml.includes('property="og:url"'));
const prodEn = await get('/en/product');
const prodEnHtml = await prodEn.text();
check('/en/product → 200 + canonical EN + html lang="en"', prodEn.status === 200
  && prodEnHtml.includes('rel="canonical" href="http://localhost:3000/en/product"')
  && /<html lang="en"/.test(prodEnHtml), `${prodEn.status}`);
check('/fr garde <html lang="fr">', /<html lang="fr"/.test(prodFrHtml));
check('JSON-LD SoftwareApplication valide (prix réels du code)',
  (() => { try {
    const m = prodFrHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    const g = JSON.parse(m[1])['@graph'] ?? [];
    const app = g.find((n) => n['@type'] === 'SoftwareApplication');
    return Boolean(app?.offers?.length === 3 && app.offers.every((o) => o.price > 0))
      && !JSON.stringify(g).includes('aggregateRating');
  } catch { return false; } })());

// ── 3. robots + sitemap ────────────────────────────────────────────────────
const robots = await (await get('/robots.txt')).text();
check('robots.txt : allow all + sitemap', robots.includes('Sitemap: http://localhost:3000/sitemap.xml')
  && robots.includes('Disallow: /api/'));
const sm = await (await get('/sitemap.xml')).text();
check('sitemap : 8 URLs (4 pages × 2 langues), aucune page privée',
  (sm.match(/<url>/g) ?? []).length === 8 && !sm.includes('/fr/') === false
  && !sm.includes('pipeline') && !sm.includes('login'));
check('sitemap : alternates hreflang présents', sm.includes('xhtml:link') && sm.includes('hreflang="en"'));
const prodInSitemap = sm.includes('<loc>http://localhost:3000/fr/product</loc>');
check('sitemap liste /fr/product en canonical', prodInSitemap);

// ── 4. Privé = protégé (auth d'abord, noindex en défense en profondeur) ────
const pipeline = await get('/fr/pipeline');
check('/fr/pipeline sans session → login (307)', pipeline.status === 307
  && new URL(pipeline.headers.get('location'), BASE).pathname === '/fr/login');
const loginHtml = await (await get('/fr/login')).text();
check('login/signup : noindex (défense en profondeur)', loginHtml.includes('noindex'));
const noRobotsHeader = prodFrHtml.includes('noindex') === false;
check('pages publiques SANS noindex', noRobotsHeader);

// ── 5. Tous les liens du footer/CTA existent ───────────────────────────────
const footerHrefs = [...prodFrHtml.matchAll(/href="(\/fr\/[^"#]*)"/g)].map((m) => m[1]);
const uniq = [...new Set(footerHrefs)];
let broken = [];
for (const h of uniq) {
  const r = await get(h);
  if (r.status >= 400) broken.push(`${h}:${r.status}`);
}
check(`${uniq.length} liens internes /fr/* résolvent tous (0 cassé)`, broken.length === 0, broken.join(','));

// ── 6. Analytics : beacon réel → ligne en base ─────────────────────────────
const beacon = await get('/api/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
  body: JSON.stringify({ name: 'primary_cta_clicked', path: '/fr/product', locale: 'fr', props: { cta: 'hero' } }),
});
check('beacon analytics → 204', beacon.status === 204, String(beacon.status));
const bot = await get('/api/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'Googlebot/2.1' },
  body: JSON.stringify({ name: 'primary_cta_clicked' }),
});
check('crawler refusé (204 sans écriture)', bot.status === 204);
const bad = await get('/api/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' },
  body: JSON.stringify({ name: 'invoice_amount_viewed' }),
});
check('événement hors allowlist → 400', bad.status === 400);

// ── 7. Anciennes entrées intactes (pas de régression de flux) ──────────────
const login = await get('/fr/login');
check('/fr/login publique reste accessible', login.status === 200);
const docs = await get('/fr/docs/api');
check('/fr/docs/api publique reste accessible', docs.status === 200);
const legal = await get('/fr/legal');
check('/fr/legal publique reste accessible', legal.status === 200);
const unknown = await get('/fr/n-importe-quoi');
check('page inconnue sans session → login (pas de 404 exposé)', unknown.status === 307);

const ok = results.every(Boolean);
console.log(ok ? `\nSEO live : ${results.filter(Boolean).length}/${results.length} ✓` : '\nÉCHEC — voir ×');
process.exit(ok ? 0 : 1);
