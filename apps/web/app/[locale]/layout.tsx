import { notFound } from 'next/navigation';
import { isLocale, type Locale, DEFAULT_LOCALE } from '@rros/i18n';
import { getSession } from '../../lib/session';

export function generateStaticParams() {
  return [{ locale: 'fr' }, { locale: 'en' }];
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const session = await getSession();
  return (
    <div data-locale={locale} data-signed-in={session ? 'true' : 'false'} lang={locale}>
      {children}
    </div>
  );
}

export const dynamic = 'force-dynamic';
