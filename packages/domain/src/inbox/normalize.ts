/**
 * Normalisation and detection primitives. Nothing here reads the network, so
 * every branch is unit-tested — including the traps: an out-of-office is not a
 * human reply, two clients called "Facturation" must not collide.
 */

export const SNIPPET_MAX = 1_000;

/** `Re: Re: RE: Rép: Devis` → `devis` — order matters, then strip to letters/digits. */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? '').trim();
  // Strip every prefix iteration: "Re: RE: Fwd: Réponse" has four.
  for (;;) {
    const next = s.replace(/^(?:\s*(?:re|rép|rep|tr|fwd|fw|tr)\s*:)+\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]+/g, '');
}

export function truncateSnippet(body: string | null | undefined, max = SNIPPET_MAX): string {
  const flat = (body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

const BOUNCE_FROM = /(?:^|[^a-z0-9])(?:mailer-daemon|mail-daemon|postmaster|mdaemon)@/i;
const BOUNCE_SUBJECT = /undeliver|delivery status|non remis|échec de livraison|returned mail|failure notice/i;

/** `Content-Type: multipart/report; report-type=delivery-status` is a bounce. */
export function isBounce(input: {
  from?: string;
  subject?: string;
  contentType?: string | null;
}): boolean {
  if (input.contentType && /multipart\/report/i.test(input.contentType)) return true;
  if (input.from && BOUNCE_FROM.test(input.from)) return true;
  return input.subject ? BOUNCE_SUBJECT.test(input.subject) : false;
}

/**
 * An out-of-office is a machine talking. The trap says: pause, don't stop.
 * `Auto-Submitted: no` is the explicit "a human wrote this" marker.
 */
export function isAutoReply(headers: Record<string, unknown>): boolean {
  const autoSubmitted = headers['auto-submitted'] ?? headers['autoSubmitted'];
  if (autoSubmitted !== undefined && autoSubmitted !== null && !/^no$/i.test(String(autoSubmitted).trim())) return true;
  return (
    (headers['x-autoreply'] ?? headers['xAutoreply']) !== undefined
    || (headers['x-autorespond'] ?? headers['xAutorespond']) !== undefined
    || /^auto_replied$/i.test(String(headers['precedence'] ?? ''))
    || headers['x-vacation'] !== undefined
  );
}

const OPT_OUT_PATTERNS: Array<[RegExp, string]> = [
  [/d[ée]sabonn/i, 'désabonner'],
  [/d[ée]sinscri/i, 'désinscrire'],
  [/ne plus me contacter/i, 'ne plus me contacter'],
  [/unsubscribe/i, 'unsubscribe'],
  [/remove\s+me/i, 'remove me'],
  [/\bstop\b/i, 'stop'],
  [/arr[êe]tez/i, 'arrêtez'],
];

/** A false positive is acceptable; a true negative is not. */
export function detectOptOut(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    if (!text) continue;
    for (const [re, keyword] of OPT_OUT_PATTERNS) {
      if (re.test(text)) return keyword;
    }
  }
  return null;
}

export type MessageDirection = 'in' | 'out';
export interface HeaderFilterResult {
  inReplyTo: string | null;
  references: string[];
  messageId: string | null;
  autoSubmitted?: string;
  xAutoreply?: string;
  xAutorespond?: string;
  precedence?: string;
  contentType?: string;
}

/**
 * Only In-Reply-To, References and Message-ID are ever persisted for matching,
 * plus the auto-reply markers the "pause 7 days" trap needs — nothing else
 * about the content survives.
 */
export function filterHeaders(headers: Record<string, string>): HeaderFilterResult {
  const pick = (name: string) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    return key ? headers[key] : undefined;
  };
  const refs = pick('references');
  const has = (v?: string) => (v !== undefined && v !== '' ? v : undefined);
  return {
    inReplyTo: pick('in-reply-to') ?? null,
    references: refs ? refs.split(/\s+/).filter(Boolean) : [],
    messageId: pick('message-id') ?? null,
    ...(has(pick('auto-submitted')) ? { autoSubmitted: pick('auto-submitted') } : {}),
    ...(has(pick('x-autoreply')) ? { xAutoreply: pick('x-autoreply') } : {}),
    ...(has(pick('x-autorespond')) ? { xAutorespond: pick('x-autorespond') } : {}),
    ...(has(pick('precedence')) ? { precedence: pick('precedence') } : {}),
    ...(has(pick('content-type')) ? { contentType: pick('content-type') } : {}),
  };
}
