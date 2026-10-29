import type { EmailProvider, OutgoingMessage, SendOutcome } from './types.ts';

/** Test double + sandbox sink. Counts every call: that count is the assertion. */
export class MemoryEmailProvider implements EmailProvider {
  readonly name = 'memory';
  readonly sent: OutgoingMessage[] = [];
  private failNext: { errorCode: string; errorMessage: string } | null = null;

  failOnce(errorCode = 'bounce', errorMessage = 'mailbox unavailable'): void {
    this.failNext = { errorCode, errorMessage };
  }

  async send(message: OutgoingMessage): Promise<SendOutcome> {
    this.sent.push(message);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      return { ok: false, ...err };
    }
    return { ok: true, providerMessageId: `mem_${this.sent.length}_${message.idempotencyKey.slice(0, 8)}` };
  }
}
