/**
 * Gmail over the plain REST gateway — no SDK, hand-rolled OAuth handling.
 * Scopes are minimal by contract: `gmail.readonly` + `gmail.send`. Never
 * `modify`, never `gmail.metadata` "for later".
 *
 * Incremental sync uses `historyId`; the first sync falls back to a capped
 * backfill (90 days, 500 messages) instead of swallowing the mailbox.
 * This module is thin on purpose: the sandbox has no Google credentials, so
 * everything around it (cursor bookkeeping, normalisation, matching, backoff)
 * is tested, and the boundary is the same MailProvider interface.
 */

const API = 'https://gmail.googleapis.com';
const AUTH = 'https://oauth2.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send';
import { BACKFILL_DAYS, BACKFILL_MAX_MESSAGES, MAX_MESSAGES_PER_RUN, RateLimitedError, ProviderRevokedError, type MailProvider, type Mailbox, type MessagePage } from './provider.ts';
import { normalise } from './provider.ts';

interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  historyId?: string;
}

function parseCredentials(mailbox: Mailbox): Credentials {
  return mailbox.credentials ? (JSON.parse(mailbox.credentials) as Credentials) : {};
}

export const GMAIL_SCOPES = SCOPE;

export function gmailAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

/** Thin transport so tests can stub `fetchMail` without a network. */
export type FetchMail = (url: string, init: RequestInit) => Promise<Response>;

const defaultFetch: FetchMail = (url, init) => fetch(url, init);

async function call<T>(fetchMail: FetchMail, path: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchMail(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (res.status === 429) throw new RateLimitedError(Number(res.headers.get('retry-after') ?? undefined));
  if (res.status === 401 || res.status === 403) throw new ProviderRevokedError();
  if (!res.ok) throw new Error(`gmail ${path} → ${res.status}`);
  return (await res.json()) as T;
}

export function gmailProvider(fetchMail: FetchMail = defaultFetch): MailProvider {
  const read = {
    async token(mailbox: Mailbox): Promise<string> {
      const creds = parseCredentials(mailbox);
      if (creds.accessToken && (!creds.expiresAt || new Date(creds.expiresAt).getTime() > Date.now() + 60_000)) {
        return creds.accessToken;
      }
      if (!creds.refreshToken) throw new ProviderRevokedError('no refresh token');
      const res = await fetchMail(`${AUTH}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GMAIL_CLIENT_ID ?? '',
          client_secret: process.env.GMAIL_CLIENT_SECRET ?? '',
          refresh_token: creds.refreshToken,
          grant_type: 'refresh_token',
        }).toString(),
      });
      if (res.status === 429) throw new RateLimitedError();
      if (!res.ok) throw new ProviderRevokedError(`refresh → ${res.status}`);
      const out = (await res.json()) as { access_token: string; expires_in: number };
      creds.accessToken = out.access_token;
      creds.expiresAt = new Date(Date.now() + out.expires_in * 1000).toISOString();
      return creds.accessToken;
    },
  };

  async function messageById(token: string, id: string): Promise<Record<string, unknown>> {
    return call(fetchMail, `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=In-Reply-To&metadataHeaders=References&metadataHeaders=Message-ID&metadataHeaders=Auto-Submitted&metadataHeaders=X-Autoreply&metadataHeaders=Content-Type`, token);
  }

  return {
    kind: 'gmail_oauth',

    async listMessages(mailbox, cursor) {
      const token = await read.token(mailbox);
      const creds = parseCredentials(mailbox);

      if (cursor) {
        // Incremental: history since the last historyId.
        const hist = await call<{ history: Array<{ messages?: Array<{ id: string }> }> }>(
          fetchMail, `/gmail/v1/users/me/history?startHistoryId=${cursor}&historyTypes=messageAdded`, token,
        );
        const ids = (hist.history ?? []).flatMap((h) => (h.messages ?? []).map((m) => m.id)).slice(0, MAX_MESSAGES_PER_RUN);
        const messages = [];
        for (const id of ids) {
          const full = await messageById(token, id!);
          messages.push(gmailToNormalised(id!, full, false));
        }
        return { messages, nextCursor: creds.historyId ?? cursor };
      }

      // First connect: capped backfill, newest first, never the whole mailbox.
      const list = await call<{ messages: Array<{ id: string }>; historyId: string }>(
        fetchMail,
        `/gmail/v1/users/me/messages?q=in:inbox newer_than:${BACKFILL_DAYS}d&maxResults=${BACKFILL_MAX_MESSAGES}`,
        token,
      );
      creds.historyId = list.historyId;
      const messages = [];
      for (const m of (list.messages ?? []).slice(0, MAX_MESSAGES_PER_RUN)) {
        const full = await messageById(token, m.id!);
        messages.push(gmailToNormalised(m.id!, full, false));
      }
      return { messages, nextCursor: list.historyId };
    },

    async send(mailbox, message) {
      const token = await read.token(mailbox);
      const mime = [
        `To: ${message.to}`,
        `Subject: ${message.subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        '',
        message.body,
      ].join('\r\n');
      const out = await call<{ id: string }>(fetchMail, '/gmail/v1/users/me/messages/send', token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }),
      });
      return { providerMessageId: out.id };
    },

    async revoke(mailbox) {
      const creds = parseCredentials(mailbox);
      if (creds.refreshToken) {
        await fetchMail(`${AUTH}/revoke?token=${encodeURIComponent(creds.refreshToken)}`, { method: 'POST' });
      }
    },
  };
}

/** Gmail metadata shape → the normalised message. Never touches message bodies
 *  unless `storeBody` — Gmail's `format=metadata` guarantees that anyway. */
export function gmailToNormalised(
  id: string,
  full: Record<string, unknown>,
  storeBody: boolean,
): ReturnType<typeof normalise> {
  const payload = (full.payload ?? {}) as {
    headers?: Array<{ name: string; value: string }>;
    body?: { data?: string };
  };
  const headers: Record<string, string> = {};
  for (const h of payload.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const body = storeBody && payload.body?.data
    ? Buffer.from(payload.body.data, 'base64url').toString('utf8')
    : undefined;
  return normalise({
    providerId: id,
    threadId: (full.threadId as string) ?? undefined,
    from: headers['from'] ?? '',
    to: (headers['to'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    cc: (headers['cc'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: headers['subject'] ?? '',
    body,
    headers,
    sentAt: new Date(Number(full.internalDate ?? Date.now())).toISOString(),
    storeBody,
  });
}
