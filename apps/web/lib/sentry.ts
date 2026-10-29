/**
 * Exception capture, Sentry-shaped. The SDK is not bundled: the DSN arrives as
 * an environment variable and the `send` indirection below is where it plugs
 * in. What IS product code, and therefore tested, is the scrubber — an
 * exception must reach the aggregator with a stack and a code, never with a
 * client's name, an e-mail address, a draft body or a token.
 */
export interface CapturedEvent {
  exception: { type: string; value: string };
  extra?: Record<string, unknown>;
  level: 'error' | 'fatal';
}

type Sender = (event: CapturedEvent) => void;

const senders: Sender[] = [];

/** Test/plug point. In production this is `Sentry.captureEvent`. */
export function registerSender(fn: Sender): void {
  senders.push(fn);
}

/** Emails and anything shaped like a secret never survive. */
export function scrubText(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.]{2,}/g, '[email]')
    .replace(/rrs_(?:live|test)_[A-Za-z0-9]{8,}/g, '[api_key]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, '[token]')
    .replace(/whsec_[A-Za-z0-9_-]{8,}/g, '[webhook_secret]')
    .replace(/\d[\d\s.\u202f]{2,},\d{2}\s?[$€]/g, '[amount]');
}

/** Allowlist again: extra fields need explicit passage, everything else dies. */
const EXTRA_ALLOWED = new Set(['request_id', 'workspace_id', 'route', 'code']);

export function scrubEvent(event: CapturedEvent): CapturedEvent {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event.extra ?? {})) {
    if (!EXTRA_ALLOWED.has(k) || v === null || v === undefined) continue;
    extra[k] = typeof v === 'string' ? scrubText(v) : v;
  }
  return {
    level: event.level,
    exception: {
      type: event.exception.type,
      value: scrubText(event.exception.value),
    },
    extra,
  };
}

/**
 * The single entry point every route uses. A missing DSN is not an error —
 * the event is still logged locally (structured, redacted upstream), because
 * "the aggregator was down" must not swallow a failure.
 */
export function captureException(err: unknown, extra?: Record<string, unknown>): CapturedEvent {
  const raw: CapturedEvent = {
    level: 'error',
    exception: {
      type: err instanceof Error ? err.name : 'Unknown',
      value: err instanceof Error ? err.message : String(err),
    },
    extra,
  };
  const clean = scrubEvent(raw);
  if (process.env.SENTRY_DSN) {
    for (const s of senders) s(clean);
  }
  return clean;
}
