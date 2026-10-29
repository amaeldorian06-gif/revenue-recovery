import type { EmailProvider, OutgoingMessage, SendOutcome } from './types.ts';

/**
 * SMTP through nodemailer, loaded lazily so the dependency is optional: a
 * workspace on Resend should not pay for it at boot.
 */
export class SmtpProvider implements EmailProvider {
  readonly name = 'smtp';

  constructor(private readonly cfg: { url: string; from: string }) {}

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    try {
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.createTransport(this.cfg.url);
      const info = await transport.sendMail({
        from: this.cfg.from,
        to: message.to,
        subject: message.subject,
        text: message.body,
        replyTo: message.replyTo,
        headers: { 'X-Idempotency-Key': message.idempotencyKey },
      });
      return { ok: true, providerMessageId: info.messageId };
    } catch (err) {
      const e = err as Error & { code?: string };
      return { ok: false, errorCode: e.code ?? 'smtp_error', errorMessage: e.message };
    }
  }
}
