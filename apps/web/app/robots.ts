import type { MetadataRoute } from 'next';
import { SITE_URL } from '../lib/site';

/**
 * Crawling rules for the PUBLIC site. The authenticated app is protected by
 * authentication and noindex metadata — robots.txt alone must never be
 * relied on to keep anything confidential.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: '*',
      allow: '/',
      disallow: ['/api/', '/*/admin'],
    }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
