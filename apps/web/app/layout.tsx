import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { DEFAULT_LOCALE, isLocale } from '@rros/i18n';
import './globals.css';

/**
 * Root metadata. `metadataBase` falls back to localhost in this sandbox — the
 * production domain is NOT known yet, so canonical URLs must be re-checked
 * against the real domain before any production deploy (documented blocker in
 * RAPPORT_CROISSANCE.md). No fake domain is invented here.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Revenue Recovery OS — Priorisez vos créances impayées',
    template: '%s — Revenue Recovery OS',
  },
  description:
    'Importez vos créances, identifiez les comptes à relancer en premier, comprenez pourquoi. La couche de priorisation au-dessus de votre outil de facturation.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // `<html lang>` was hardcoded "fr" — wrong for /en pages. The middleware
  // sets an x-locale REQUEST header on every locale path; reading it here
  // keeps the declaration correct for screen readers and crawlers.
  const h = await headers();
  const claimed = h.get('x-locale') ?? DEFAULT_LOCALE;
  const lang = isLocale(claimed) ? claimed : DEFAULT_LOCALE;
  return (
    <html lang={lang}>
      <body>{children}</body>
    </html>
  );
}
