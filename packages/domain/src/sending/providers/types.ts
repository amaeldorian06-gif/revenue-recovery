/**
 * One interface for every sender. The job never knows which provider it talks to,
 * which is what lets the sandbox, Resend, Gmail and SMTP share a single code path
 * — and lets the tests assert "exactly one provider call" without a network.
 */
export interface OutgoingMessage {
  to: string;
  subject: string;
  body: string;
  /** Derived from the action UUID: the provider deduplicates on it. */
  idempotencyKey: string;
  replyTo?: string;
}

export interface SendOutcome {
  ok: boolean;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingMessage): Promise<SendOutcome>;
}
