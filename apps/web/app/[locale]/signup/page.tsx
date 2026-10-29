import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PagePing } from '../../../lib/analytics_client';
import { translator } from '@rros/i18n';
import { getSession } from '../../../lib/session';
import { AuthForm } from '../../../components/AuthForm';

/** Private or tokenized page: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function SignupPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // A VALID session skips the auth page (invalid/stale cookies stay here —
  // the middleware deliberately does not decide, see its NOTE).
  if (await getSession()) redirect(`/${locale}`);
  const l = locale === 'en' ? 'en' : 'fr';
  const tr = translator(l);
  return (
    <main className="wrap">
      {/* Funnel public : le DÉBUT d'inscription (la complétion vit dans funnel_events). */}
      <PagePing event="signup_started" />
      <div className="auth">
        <div className="brand" style={{ marginBottom: 22 }}>
          <div className="logo">RR</div>
          <div>
            <h1>{tr('app.name')}</h1>
            <p>{tr('app.tagline')}</p>
          </div>
        </div>
        <div className="card">
          <div className="pad">
            <h2>{tr('auth.signup.title')}</h2>
            <p className="sub">{tr('auth.signup.subtitle')}</p>
            <AuthForm mode="signup" locale={l} />
            <p className="sub" style={{ marginTop: 16 }}>
              {tr('auth.hasAccount')}{' '}
              <a href={`/${l}/login`} style={{ color: 'var(--accent-ink)', fontWeight: 600 }}>
                {tr('auth.signin.title')}
              </a>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
