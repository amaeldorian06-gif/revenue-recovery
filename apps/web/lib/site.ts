import type { MetadataRoute } from 'next';

/**
 * The single source of the public site URL. The production domain is not
 * known yet (sandbox) — every canonical/sitemap URL derives from this one
 * constant, so pointing the whole site at the real domain is a one-line env
 * change (NEXT_PUBLIC_SITE_URL), never a content edit.
 */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** Public, indexable routes (relative, per locale). Private pages are NOT listed — they are also auth-gated and noindex; robots.txt is never the privacy control. */
export const PUBLIC_PATHS = ['/product', '/pricing', '/security', '/legal'] as const;

export const LOCALES = ['fr', 'en'] as const;

import type { Metadata } from 'next';

/**
 * Per-page metadata for a public page: locale-correct title/description,
 * self-referencing canonical and reciprocal hreflang alternates. Pages keep
 * their own wording; only the plumbing is shared.
 */
export function pageMeta(
  locale: string, path: (typeof PUBLIC_PATHS)[number],
  title: string, description: string,
): Metadata {
  const l = locale === 'en' ? 'en' : 'fr';
  return {
    title,
    description,
    alternates: {
      canonical: `${SITE_URL}/${l}${path}`,
      languages: Object.fromEntries([
        ...LOCALES.map((x) => [x, `${SITE_URL}/${x}${path}`]),
        ['x-default', `${SITE_URL}/fr${path}`],
      ]),
    },
    openGraph: {
      title,
      description,
      url: `${SITE_URL}/${l}${path}`,
      siteName: 'Revenue Recovery OS',
      locale: l === 'fr' ? 'fr_FR' : 'en_GB',
      type: 'website',
    },
  };
}

