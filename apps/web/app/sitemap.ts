import type { MetadataRoute } from 'next';
import { SITE_URL, PUBLIC_PATHS, LOCALES } from '../lib/site';

/**
 * Only canonical, intended-to-be-indexed URLs. Authenticated dashboards,
 * private data, /api and tokenized routes are deliberately absent — the
 * sitemap is an indexing ADDITION, never a security boundary.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];
  for (const path of PUBLIC_PATHS) {
    for (const locale of LOCALES) {
      entries.push({
        url: `${SITE_URL}/${locale}${path}`,
        changeFrequency: path === '/product' ? 'weekly' : 'monthly',
        priority: path === '/product' ? 1 : 0.6,
        alternates: {
          languages: Object.fromEntries(LOCALES.map((l) => [l, `${SITE_URL}/${l}${path}`])),
        },
      });
    }
  }
  return entries;
}
