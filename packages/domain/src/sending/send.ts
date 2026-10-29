/**
 * One send, end to end, without touching the database.
 *
 * The order below is the whole guarantee: stop rules first, then the message,
 * then exactly one provider call. The job cannot "send and then check" — by the
 * time you can check, the message is out.
 */
import { checkStopRules, type SendState, type StopCode } from './stopRules.ts';
import type { EmailProvider, SendOutcome } from './providers/types.ts';

export interface SendSubject {
  actionId: string;
  subject: string;
  body: string;
  recipientEmail: string | null;
}

export interface SandboxConfig {
  enabled: boolean;
  /** Where a sandbox message actually goes: the workspace owner, never the client. */
  ownerEmail: string;
}

export interface ExecuteSendInput {
  action: SendSubject;
  state: SendState;
  provider: EmailProvider;
  sandbox: SandboxConfig;
  now: Date;
  replyTo?: string;
}

export type SendResult =
  | { status: 'sent'; providerName: string; providerMessageId?: string; sandbox: boolean; to: string }
  | { status: 'cancelled'; code: StopCode; detail?: string }
  | { status: 'failed'; errorCode: string; errorMessage: string; providerName: string };

export const SANDBOX_PREFIX = '[SANDBOX]';

export async function executeSend(input: ExecuteSendInput): Promise<SendResult> {
  const verdict = checkStopRules(input.state, input.now);
  if (!verdict.sendable) {
    return { status: 'cancelled', code: verdict.code!, detail: verdict.detail };
  }

  const recipient = input.sandbox.enabled ? input.sandbox.ownerEmail : input.action.recipientEmail;
  if (!recipient) {
    return {
      status: 'failed',
      errorCode: 'no_recipient',
      errorMessage: 'aucune adresse e-mail pour ce dossier',
      providerName: input.provider.name,
    };
  }

  const subject = input.sandbox.enabled
    ? `${SANDBOX_PREFIX} ${input.action.subject}`.trim()
    : input.action.subject;

  const outcome: SendOutcome = await input.provider.send({
    to: recipient,
    subject,
    body: input.action.body,
    // Derived from the action UUID: a retried job cannot create a second message,
    // even if it reaches the provider twice.
    idempotencyKey: input.action.actionId,
    replyTo: input.replyTo,
  });

  if (!outcome.ok) {
    return {
      status: 'failed',
      errorCode: outcome.errorCode ?? 'unknown',
      errorMessage: outcome.errorMessage ?? 'provider refused the message',
      providerName: input.provider.name,
    };
  }

  return {
    status: 'sent',
    providerName: input.provider.name,
    providerMessageId: outcome.providerMessageId,
    sandbox: input.sandbox.enabled,
    to: recipient,
  };
}
