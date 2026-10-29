import { NextResponse, type NextRequest } from 'next/server';
import { isLocale, DEFAULT_LOCALE } from '@rros/i18n';

const PUBLIC = ['/login', '/signup', '/docs', '/legal', '/invite', '/product', '/pricing', '/security'];

/**
 * Locale + auth routing, plus the security-header checklist of phase 08:
 * HSTS, CSP with a per-request nonce (scripts never get `unsafe-inline`),
 * X-Frame-Options, Referrer-Policy, Permissions-Policy. Next picks the nonce
 * up from the CSP header and tags its own scripts with it.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasLocale = isLocale(pathname.split('/')[1]);

  if (!hasLocale && !pathname.startsWith('/api') && !pathname.startsWith('/_next')) {
    const url = req.nextUrl.clone();
    // `/` is the acquisition entry: a cold visitor lands on the PUBLIC product
    // page, never on a login wall. Every other locale-less path keeps the
    // historical prefix redirect.
    url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '/product' : pathname}`;
    return withSecurityHeaders(req, NextResponse.redirect(url));
  }

  const rest = hasLocale ? pathname.replace(/^\/[a-z]{2}/, '') : pathname;
  const isPublic = PUBLIC.some((p) => rest === p || rest.startsWith(`${p}/`));
  const hasSession = req.cookies.has('rros_session');

  if (!isPublic && !hasSession && !pathname.startsWith('/api')) {
    const locale = pathname.split('/')[1] ?? DEFAULT_LOCALE;
    const url = req.nextUrl.clone();
    url.pathname = `/${locale}/login`;
    return withSecurityHeaders(req, NextResponse.redirect(url));
  }
  // NOTE: no /login→/ redirect here. Whether a session cookie is VALID is a
  // database fact (revocable sessions, 0010) the middleware cannot judge; the
  // login/signup pages do that check themselves. Redirecting on mere cookie
  // PRESENCE dead-loops any holder of a stale cookie between the two layers.

  // Request header for the root layout (`<html lang>` must match the actual
  // locale — it was hardcoded "fr", wrong for /en). Response-only headers do
  // not reach RSC; a REQUEST header does.
  const reqHeaders = new Headers(req.headers);
  if (hasLocale) reqHeaders.set('x-locale', pathname.split('/')[1] ?? DEFAULT_LOCALE);
  const res = NextResponse.next({ request: { headers: reqHeaders } });

  // First-party analytics identity: a random ID, no PII, readable only by the
  // server. It lets funnel events be correlated without any profile.
  if (!req.cookies.has('rros_anid')) {
    res.cookies.set('rros_anid', crypto.randomUUID(), {
      path: '/', maxAge: 180 * 24 * 3600, sameSite: 'lax', httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
    });
  }
  return withSecurityHeaders(req, res);
}

function withSecurityHeaders(req: NextRequest, res: NextResponse): NextResponse {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const dev = process.env.NODE_ENV !== 'production';
  // Scripts: self + nonce + strict-dynamic. `unsafe-eval` is dev-only
  // (React refresh); production never gets it. Styles stay inline — the UI
  // is styled server-side; stylesheets cannot execute.
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''} https://cdn.redoc.ly`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'" + (dev ? ' ws: wss:' : ''),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  res.headers.set('content-security-policy', csp);
  res.headers.set('x-nonce', nonce);
  // HSTS matters behind TLS; harmless locally.
  res.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  res.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt|sitemap.xml|screenshots|downloads).*)'],
};
