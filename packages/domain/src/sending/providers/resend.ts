import type { EmailProvider, OutgoingMessage, SendOutcome } from './types.ts';

/** Resend over HTTP. The idempotency key is passed as a header, per their API. */
export class ResendProvider implements EmailProvider {
  readonly name = 'resend';

  constructor(
    private readonly cfg: { apiKey: string; from: string; timeoutMs?: number },
  ) {}

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.cfg.from,
          to: message.to,
          subject: message.subject,
          text: message.body,
          reply_to: message.replyTo,
        }),
        signal: controller.signal,
      });
      const payload = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) {
        return { ok: false, errorCode: `http_${res.status}`, errorMessage: payload.message ?? 'resend error' };
      }
      return { ok: true, providerMessageId: payload.id };
    } catch (err) {
      return { ok: false, errorCode: 'network', errorMessage: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  }
}
