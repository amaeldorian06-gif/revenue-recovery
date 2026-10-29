import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { translator } from '@rros/i18n';
import { getSession } from '../../../lib/session';
import { AuthForm } from '../../../components/AuthForm';
import { demoLoginAction } from '../../../lib/actions/onboarding';

/** Private or tokenized page: never indexed. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function LoginPage({
  params, searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ sent?: string; dev_token?: string; error?: string }>;
}) {
  const { locale } = await params;
  // A VALID session skips the auth page (invalid/stale cookies stay here —
  // the middleware deliberately does not decide, see its NOTE).
  if (await getSession()) redirect(`/${locale}`);
  const q = await searchParams;
  const l = locale === 'en' ? 'en' : 'fr';
  const tr = translator(l);
  return (
    <main className="wrap">
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
            <h2>{tr('auth.signin.title')}</h2>
            <p className="sub">{tr('auth.signin.subtitle')}</p>
            {q.sent === '1' && (
              <p data-testid="magic-sent" style={{ background: '#f2f7ff', border: '1px solid var(--accent)', borderRadius: 8, padding: '8px 12px', fontSize: 13, wordBreak: 'break-all' }}>
                {l === 'fr'
                  ? 'Lien de connexion envoyé (valable 15 minutes, utilisable une seule fois).'
                  : 'Login link sent (valid 15 minutes, single use).'}
                {q.dev_token && (
                  <>
                    {' '}<a href={`/api/auth/verify?token=${q.dev_token}`} data-testid="magic-dev-link">{l === 'fr' ? 'Ouvrir le lien (dev)' : 'Open the link (dev)'}</a>
                  </>
                )}
              </p>
            )}
            {q.error === 'link_invalid' && (
              <p data-testid="magic-invalid" style={{ color: '#b42318', fontSize: 13 }}>
                {l === 'fr' ? 'Lien expiré ou déjà utilisé.' : 'Link expired or already used.'}
              </p>
            )}
            <AuthForm mode="signin" locale={l} />
            <form action={demoLoginAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="locale" value={l} />
              <button className="btn" type="submit" data-testid="demo-login" style={{ width: '100%' }}>
                {tr('auth.demo')}
              </button>
            </form>
            <p className="sub" style={{ marginTop: 16 }}>
              {tr('auth.noAccount')}{' '}
              <a href={`/${l}/signup`} style={{ color: 'var(--accent-ink)', fontWeight: 600 }}>
                {tr('auth.signup.title')}
              </a>
            </p>
          </div>
        </div>
        <p className="sub" style={{ marginTop: 14, fontSize: 12 }}>
          Phase 01 — local auth adapter. Production uses Supabase magic links.
        </p>
      </div>
    </main>
  );
}
