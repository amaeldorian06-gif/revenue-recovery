import { redirect } from 'next/navigation';
import { isLocale, translator } from '@rros/i18n';
import { getSession } from '../../../lib/session';
import { TrackedCta } from '../../../lib/analytics_client';

/**
 * Public marketing shell — same design tokens as the app (§17 consistency),
 * zero session requirement, every link points at a route that exists.
 */

export default async function PublicLayout({
  children, params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale: raw } = await params;
  if (!isLocale(raw)) redirect('/fr');
  const fr = raw === 'fr';
  const session = await getSession();
  const tr = translator(raw);
  const label = (k: 'product' | 'pricing' | 'security'): string =>
    fr ? { product: 'Produit', pricing: 'Tarifs', security: 'Sécurité' }[k]
       : { product: 'Product', pricing: 'Pricing', security: 'Security' }[k];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header className="topbar">
        <div className="topbar-inner">
          <a href={`/${raw}/product`} style={{ display: 'flex', gap: 10, alignItems: 'center', textDecoration: 'none', color: 'inherit' }}>
            <div className="logo" style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14 }}>RR</div>
            <div>
              <h1 style={{ margin: 0, fontSize: 15.5, fontWeight: 680 }}>Revenue Recovery OS</h1>
              <div className="sub" style={{ fontSize: 11.5 }}>{fr ? 'Priorisation de créances B2B' : 'B2B receivables prioritization'}</div>
            </div>
          </a>
          <nav style={{ display: 'flex', gap: 14, alignItems: 'center' }} aria-label={fr ? 'Navigation principale' : 'Main navigation'}>
            {(['product', 'pricing', 'security'] as const).map((k) => (
              <a key={k} href={`/${raw}/${k}`} style={{ textDecoration: 'none', color: 'var(--ink-2)', fontSize: 13.5, fontWeight: 560 }}>{label(k)}</a>
            ))}
            {session ? (
              <a className="btn primary" href={`/${raw}`} style={{ textDecoration: 'none' }}>{fr ? 'Ouvrir l’app' : 'Open app'}</a>
            ) : (
              <>
                <a className="btn" href={`/${raw}/login`} style={{ textDecoration: 'none' }}>{fr ? 'Connexion' : 'Sign in'}</a>
                <TrackedCta href={`/${raw}/signup`} event="primary_cta_clicked" className="btn primary" testid="nav-cta"
                  style={{ textDecoration: 'none' }}>
                  {fr ? 'Créer un compte' : 'Create an account'}
                </TrackedCta>
              </>
            )}
          </nav>
        </div>
      </header>

      <main style={{ flex: 1 }}>{children}</main>

      <footer style={{ borderTop: '1px solid var(--line)', background: '#fff', marginTop: 40 }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '22px 20px', display: 'flex', gap: 28, flexWrap: 'wrap', fontSize: 13, color: 'var(--ink-2)' }}>
          <div style={{ minWidth: 200 }}>
            <strong style={{ color: 'var(--ink)' }}>Revenue Recovery OS</strong>
            <p className="sub" style={{ fontSize: 12 }}>
              {fr ? 'La couche de priorisation au-dessus de votre outil de facturation. Les créances restent les vôtres ; nous aidons à décider quoi relancer en premier.'
                  : 'The prioritization layer on top of your invoicing tool. Your receivables stay yours; we help you decide what to chase first.'}
            </p>
          </div>
          <nav aria-label={fr ? 'Produit' : 'Product'}>
            <div style={{ fontWeight: 640, color: 'var(--ink)', marginBottom: 6 }}>{fr ? 'Produit' : 'Product'}</div>
            <a href={`/${raw}/product`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{label('product')}</a>
            <a href={`/${raw}/pricing`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{label('pricing')}</a>
            <a href={`/${raw}/docs/api`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>API</a>
          </nav>
          <nav aria-label={fr ? 'Confiance' : 'Trust'}>
            <div style={{ fontWeight: 640, color: 'var(--ink)', marginBottom: 6 }}>{fr ? 'Confiance' : 'Trust'}</div>
            <a href={`/${raw}/security`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{label('security')}</a>
            <a href={`/${raw}/legal`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{fr ? 'Mentions légales' : 'Legal'}</a>
            <a href={`/${raw}/legal/data-processing`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{fr ? 'Données & rétention' : 'Data & retention'}</a>
          </nav>
          <nav aria-label={fr ? 'Compte' : 'Account'}>
            <div style={{ fontWeight: 640, color: 'var(--ink)', marginBottom: 6 }}>{fr ? 'Compte' : 'Account'}</div>
            <a href={`/${raw}/login`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{fr ? 'Connexion' : 'Sign in'}</a>
            <a href={`/${raw}/signup`} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>{fr ? 'Créer un compte' : 'Create an account'}</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
