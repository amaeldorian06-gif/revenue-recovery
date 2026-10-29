import type { EmailProvider, OutgoingMessage, SendOutcome } from './types.ts';

/**
 * Gmail API with a ready-made access token (phase 07 owns the OAuth dance and
 * the encrypted refresh token; this phase only needs to be able to send).
 */
export class GmailProvider implements EmailProvider {
  readonly name = 'gmail';

  constructor(
    private readonly cfg: { accessToken: string; from: string; timeoutMs?: number },
  ) {}

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    const raw = [
      `From: ${this.cfg.from}`,
      `To: ${message.to}`,
      `Subject: ${encodeHeader(message.subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      message.body,
    ].join('\r\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw: base64url(raw) }),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
      if (!res.ok) {
        return { ok: false, errorCode: `http_${res.status}`, errorMessage: payload.error?.message ?? 'gmail error' };
      }
      return { ok: true, providerMessageId: payload.id };
    } catch (err) {
      return { ok: false, errorCode: 'network', errorMessage: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}

const encodeHeader = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const base64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
