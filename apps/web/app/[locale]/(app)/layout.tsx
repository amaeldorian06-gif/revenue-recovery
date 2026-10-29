import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { translator, isLocale } from '@rros/i18n';
import { getSession } from '../../../lib/session';
import { signoutAction } from '../../../lib/actions/auth';
import { SubscriptionBanner } from '../../../components/SubscriptionBanner';
import { SyncHealthBanner } from '../../../components/SyncHealthBanner';
import { getEntitlement } from '../../../lib/licensing';

/** Private app: never indexed (auth is the real lock; this is defense in depth). */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) redirect('/fr');
  const session = await getSession();
  if (!session) redirect(`/${locale}/login`);
  // Licensing gate (0009): the product UI renders only for an entitled
  // workspace. This is a navigation filter — the real enforcement also lives
  // in every mutating API route and in the send job, never here alone.
  const entitlement = await getEntitlement(session);
  if (!entitlement.accessAllowed) redirect(`/${locale}/subscription`);
  const tr = translator(locale);

  const tabs = [
    { href: `/${locale}`, label: tr('nav.today'), exact: true },
    { href: `/${locale}/ar`, label: tr('nav.ar'), exact: false },
    { href: `/${locale}/pipeline`, label: tr('nav.pipeline'), exact: false },
    { href: `/${locale}/results`, label: tr('nav.results'), exact: false },
    { href: `/${locale}/settings`, label: tr('nav.settings'), exact: false },
  ];

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="logo">RR</div>
            <div>
              <h1>{tr('app.name')}</h1>
              <p>{session.email}</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="pill live">{tr('today.trial')}</span>
            <form action={signoutAction}>
              <input type="hidden" name="locale" value={locale} />
              <button className="btn" type="submit" style={{ padding: '6px 11px', fontSize: 12.5 }}>
                {tr('nav.signout')}
              </button>
            </form>
          </div>
        </div>
      </header>
      <div className="wrap">
        <nav className="tabs">
          {tabs.map((tab) => (
            <a key={tab.href} href={tab.href}>
              {tab.label}
            </a>
          ))}
        </nav>
        <SubscriptionBanner session={session} locale={locale} />
        <SyncHealthBanner session={session} locale={locale} />
        <main>{children}</main>
      </div>
    </>
  );
}
