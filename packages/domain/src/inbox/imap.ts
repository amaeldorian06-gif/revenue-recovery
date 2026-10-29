/**
 * Generic IMAP/SMTP provider. `imapflow` is imported lazily: the sandbox has no
 * npm registry access, so the transport boundary stays thin and untested while
 * everything around it (UID cursor, caps, normalisation) is shared with the
 * tested path. TLS is mandatory; app passwords are stored encrypted (secretBox)
 * and never logged.
 */
import {
  BACKFILL_DAYS, BACKFILL_MAX_MESSAGES, MAX_MESSAGES_PER_RUN,
  RateLimitedError, type MailProvider,
} from './provider.ts';
import { normalise } from './provider.ts';

export interface ImapCredentials {
  host: string;
  port: number;
  user: string;
  password: string; // decrypted at use time
  tls?: boolean; // default true; false is refused
}

export function parseImapCredentials(raw: string | null): ImapCredentials {
  if (!raw) throw new Error('no credentials stored');
  const creds = JSON.parse(raw) as Partial<ImapCredentials>;
  if (creds.tls === false) throw new Error('IMAP without TLS is refused');
  return { host: creds.host ?? '', port: creds.port ?? 993, user: creds.user ?? '',
           password: creds.password ?? '', tls: true };
}

/** Minimal structural type of the parts of imapflow we use, so the module
 *  compiles without the package installed (sandbox has no registry access). */
interface ImapFlowClient {
  connect(): Promise<void>;
  logout(): Promise<void>;
  getMailboxLock(name: string): Promise<{ release(): void }>;
  fetch(range: string, opts: Record<string, boolean>): AsyncIterable<{
    uid: number;
    envelope?: {
      from?: Array<{ address?: string; name?: string }>;
      to?: Array<{ address?: string }>;
      cc?: Array<{ address?: string }>;
      subject?: string;
      date?: Date;
    };
    headers?: Buffer | string;
  }>;
}
interface ImapFlowModule {
  ImapFlow: new (opts: Record<string, unknown>) => ImapFlowClient;
}

/** Indirection keeps the optional dependency out of the type checker's reach. */
const importImapFlow: () => Promise<ImapFlowModule | null> = () =>
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function('return import("imapflow")')() as Promise<ImapFlowModule>).catch(() => null);

export function imapProvider(load: ImapFlowModule | null = null): MailProvider {
  return {
    kind: 'smtp_imap',

    async listMessages(mailbox, cursor) {
      // Lazily: the package is optional at build time, required at sync time.
      const mod = load ?? await importImapFlow();
      if (!mod) {
        throw new RateLimitedError(3600); // nothing to fetch with; retry later, cursor intact
      }
      const creds = parseImapCredentials(mailbox.credentials);
      const client = new mod.ImapFlow({
        host: creds.host,
        port: creds.port,
        secure: creds.tls,
        auth: { user: creds.user ?? '', pass: creds.password ?? '' },
        logger: false,
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock('INBOX');
        const messages = [];
        let highest = cursor ? Number(cursor) : 0;
        try {
          // UID cursor: everything strictly above the watermark, capped.
          const range = `${highest + 1}:*`;
          for await (const msg of client.fetch(range, { uid: true, envelope: true, headers: true, bodyStructure: true })) {
            if (messages.length >= MAX_MESSAGES_PER_RUN) break;
            if (msg.uid <= highest) continue;
            const headers = String(msg.headers ?? '');
            const get = (name: string) =>
              new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(headers)?.[1]?.trim();
            const envFrom = msg.envelope?.from?.[0];
            const from = envFrom?.address
              ? `${envFrom.name ?? ''} <${envFrom.address}>`
              : '';
            messages.push(normalise({
              providerId: String(msg.uid),
              from,
              to: (msg.envelope?.to ?? []).map((a: { address?: string }) => a.address ?? '').filter(Boolean),
              cc: (msg.envelope?.cc ?? []).map((a: { address?: string }) => a.address ?? '').filter(Boolean),
              subject: msg.envelope?.subject ?? '',
              headers: {
                'in-reply-to': get('In-Reply-To') ?? '',
                references: get('References') ?? '',
                'message-id': get('Message-ID') ?? '',
                'auto-submitted': get('Auto-Submitted') ?? '',
              },
              sentAt: (msg.envelope?.date ?? new Date()).toISOString(),
              storeBody: false,
            }));
            highest = Math.max(highest, msg.uid);
          }
        } finally {
          lock.release();
        }
        await client.logout();
        return { messages, nextCursor: String(highest) };
      } catch (err) {
        if ((err as { text?: string })?.text?.includes('RATELIMIT') || (err as Error).message?.includes('429')) {
          throw new RateLimitedError();
        }
        throw err;
      }
    },

    async send(mailbox, message) {
      const mod = load ?? await importImapFlow();
      if (!mod) throw new Error('SMTP transport unavailable in this environment');
      const creds = parseImapCredentials(mailbox.credentials);
      // SMTP submission through nodemailer is the phase 08 concern; until then
      // sandbox sending covers e2e, and this path stays explicit.
      throw new Error(`smtp send to ${message.to} via ${creds.host}: wired in phase 08`);
    },

    async revoke() {
      // Nothing to revoke server-side for password auth; the local secret is
      // destroyed by disconnectMailbox().
    },
  };
}

export const IMAP_CAPS = { BACKFILL_DAYS, BACKFILL_MAX_MESSAGES };
