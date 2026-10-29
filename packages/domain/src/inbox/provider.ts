import { truncateSnippet, isBounce, isAutoReply, filterHeaders } from './normalize.ts';

/**
 * The provider abstraction exactly as the phase prompt fixes it. Implementations:
 *  - `GmailMailProvider`  — REST, `gmail.readonly` + `gmail.send`, historyId cursor;
 *  - `ImapMailProvider`   — imapflow, UID cursor, TLS mandatory;
 *  - `SandboxMailProvider`— a scripted inbox (sandbox mailboxes, tests, dev flow).
 * One provider per mailbox; a workspace holds up to its plan limit.
 */

export interface Mailbox {
  id: string;
  workspaceId: string;
  provider: 'gmail_oauth' | 'smtp_imap' | 'sandbox';
  email: string | null;
  cursor: string | null;
  credentials: string | null; // decrypted payload, never persisted raw
  /** The workspace's privacy choice, resolved by the sync engine before list. */
  storeBody?: boolean;
}

export interface NormalisedMessage {
  providerId: string;
  threadId?: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  snippet: string; // ≤ 1 000 chars, always
  body?: string; // only when workspace.store_body = true
  headers: Record<string, string>;
  sentAt: string;
  isBounce: boolean;
}

export interface MessagePage {
  messages: NormalisedMessage[];
  nextCursor: string;
}

export class RateLimitedError extends Error {
  override readonly name = 'RateLimitedError';
  constructor(public retryAfterSeconds?: number) {
    super('provider rate limited (429)');
  }
}

export class ProviderRevokedError extends Error {
  constructor(message = 'provider token revoked or expired') {
    super(message);
  }
}

export interface MailProvider {
  readonly kind: Mailbox['provider'];
  listMessages(mailbox: Mailbox, cursor: string | null): Promise<MessagePage>;
  send(mailbox: Mailbox, message: { to: string; subject: string; body: string }): Promise<{ providerMessageId: string }>;
  revoke(mailbox: Mailbox): Promise<void>;
}

/** Initial backfill caps — a first connect must not swallow a whole mailbox. */
export const BACKFILL_DAYS = 90;
export const BACKFILL_MAX_MESSAGES = 500;
export const MAX_MESSAGES_PER_RUN = 200;
export const SYNC_DEADLINE_MS = 30_000;

/** Normalises a raw provider message into the phase prompt's shape. */
export function normalise(raw: {
  providerId: string;
  threadId?: string;
  from: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  body?: string;
  headers?: Record<string, string>;
  sentAt: string;
  storeBody: boolean;
}): NormalisedMessage {
  const headers = raw.headers ?? {};
  const contentType = headers['content-type'] ?? null;
  return {
    providerId: raw.providerId,
    ...(raw.threadId ? { threadId: raw.threadId } : {}),
    from: raw.from,
    to: raw.to ?? [],
    cc: raw.cc ?? [],
    subject: raw.subject ?? '',
    snippet: truncateSnippet(raw.body),
    ...(raw.storeBody && raw.body ? { body: raw.body } : {}),
    headers: filterHeaders(headers) as unknown as Record<string, string>,
    sentAt: raw.sentAt,
    isBounce: isBounce({ from: raw.from, subject: raw.subject, contentType }),
  };
}

/**
 * The scripted provider behind sandbox mailboxes. Messages are *delivered* by
 * the dev route or the tests, then fetched with a cursor exactly like a real
 * provider — so the cron route, matching and cancellation run unmodified.
 */
export class SandboxMailProvider implements MailProvider {
  readonly kind = 'sandbox' as const;
  /** Internal, exposed to tests via reset()/peek(); not an API. */
  readonly inboxes = new Map<string, NormalisedMessage[]>();
  private readonly sent = new Map<string, Array<{ to: string; subject: string; body: string }>>();

  /** Delivers a message into a mailbox's scripted inbox. */
  deliver(mailboxId: string, message: NormalisedMessage): void {
    const box = this.inboxes.get(mailboxId) ?? [];
    box.push(message);
    this.inboxes.set(mailboxId, box);
  }

  outbox(mailboxId: string): Array<{ to: string; subject: string; body: string }> {
    return this.sent.get(mailboxId) ?? [];
  }

  async listMessages(mailbox: Mailbox, cursor: string | null): Promise<MessagePage> {
    const box = this.inboxes.get(mailbox.id) ?? [];
    const start = cursor ? Number(cursor) : 0;
    // Cursor is an offset into the scripted stream — deterministic, resumable.
    const slice = box.slice(start, start + MAX_MESSAGES_PER_RUN);
    return { messages: slice, nextCursor: String(start + slice.length) };
  }

  async send(mailbox: Mailbox, message: { to: string; subject: string; body: string }) {
    const box = this.sent.get(mailbox.id) ?? [];
    box.push(message);
    this.sent.set(mailbox.id, box);
    return { providerMessageId: `sandbox-${mailbox.id.slice(0, 8)}-${box.length}` };
  }

  async revoke(): Promise<void> {}
}

const globalForMail = globalThis as unknown as { __rrosSandboxMail?: SandboxMailProvider };

/** Process-wide sandbox provider, shared between routes and tests. */
export function sandboxMail(): SandboxMailProvider {
  globalForMail.__rrosSandboxMail ??= new SandboxMailProvider();
  return globalForMail.__rrosSandboxMail;
}

export { isAutoReply };
