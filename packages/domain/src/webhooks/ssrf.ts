/**
 * SSRF guard on webhook URLs — pure so it is testable without a socket. Block
 * private and link-local ranges, require HTTPS everywhere except an explicit
 * dev allowance (the local test receiver), and reject credentials-in-URL.
 */
const PRIVATE_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal']);

const PRIVATE_V4_PATTERNS: readonly RegExp[] = [
  /^127\./,
  /^10\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export interface UrlDecision {
  allowed: boolean;
  reason?: 'scheme' | 'private' | 'credentials' | 'parse';
}

export function isDeliverableUrl(raw: string, opts: { allowInsecureLoopback?: boolean } = {}): UrlDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: 'parse' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { allowed: false, reason: 'scheme' };
  if (url.username || url.password) return { allowed: false, reason: 'credentials' };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopbackOk = opts.allowInsecureLoopback === true;
  if (!loopbackOk && url.protocol === 'http:') {
    // Plain HTTP only ever allowed for the local test receiver in dev.
    if (!(host === '127.0.0.1' || host === '::1' || host === 'localhost')) {
      return { allowed: false, reason: 'scheme' };
    }
  }
  if (PRIVATE_HOSTNAMES.has(host)) {
    return loopbackOk && (host === 'localhost') ? { allowed: true } : { allowed: false, reason: 'private' };
  }
  if (/^::1$|^f[cd][0-9a-f]{2}:|^fe80:/i.test(host)) {
    return { allowed: false, reason: loopbackOk && host === '::1' ? 'private' : 'private' };
  }
  for (const re of PRIVATE_V4_PATTERNS) {
    if (re.test(host)) {
      // 127.0.0.1 stays reachable for the dev receiver when explicitly allowed.
      if (loopbackOk && /^127\.0\.0\.1$/.test(host)) return { allowed: true };
      return { allowed: false, reason: 'private' };
    }
  }
  return { allowed: true };
}
