import { MemoryEmailProvider } from './memory.ts';
import { ResendProvider } from './resend.ts';
import { GmailProvider } from './gmail.ts';
import { SmtpProvider } from './smtp.ts';
import type { EmailProvider } from './types.ts';

export type { EmailProvider, OutgoingMessage, SendOutcome } from './types.ts';
export { MemoryEmailProvider, ResendProvider, GmailProvider, SmtpProvider };

/**
 * Pick the sender from the environment. No credentials → the memory provider,
 * which records the message instead of delivering it: the flow stays demonstrable
 * and nothing can leave the machine by accident.
 */
export function defaultEmailProvider(env: Record<string, string | undefined> = process.env): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend' && env.RESEND_API_KEY) {
    return new ResendProvider({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM ?? 'no-reply@example.com' });
  }
  if (env.EMAIL_PROVIDER === 'gmail' && env.GMAIL_ACCESS_TOKEN) {
    return new GmailProvider({ accessToken: env.GMAIL_ACCESS_TOKEN, from: env.EMAIL_FROM ?? 'me@example.com' });
  }
  if (env.EMAIL_PROVIDER === 'smtp' && env.SMTP_URL) {
    return new SmtpProvider({ url: env.SMTP_URL, from: env.EMAIL_FROM ?? 'no-reply@example.com' });
  }
  return new MemoryEmailProvider();
}
