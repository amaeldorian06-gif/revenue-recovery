'use client';

/**
 * Analytics — CLIENT side. A 1 KB beacon island: `track()` posts to
 * /api/events (same-origin, allowed by the CSP `connect-src 'self'`), the
 * event NAME must be on the server allowlist, and no value passed here is
 * ever free text that reaches the database untouched.
 */
export function track(name: string, props: Record<string, string> = {}): void {
  try {
    const body = JSON.stringify({ name, props, path: location.pathname, locale: document.documentElement.lang });
    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch('/api/events', { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } });
  } catch {
    /* analytics must never break navigation */
  }
}

/** Fire-and-forget page event (landing view, pricing view, signup start). */
export function PagePing({ event }: { event: string }): null {
  track(event);
  return null;
}

/** A real link that measures its own clicks — no fake button, no JS-only CTA. */
export function TrackedCta({
  href, event, children, className, style, testid,
}: {
  href: string; event: string; children: React.ReactNode;
  className?: string; style?: React.CSSProperties; testid?: string;
}) {
  return (
    <a href={href} className={className} style={style} data-testid={testid}
       onClick={() => track(event)}>
      {children}
    </a>
  );
}
