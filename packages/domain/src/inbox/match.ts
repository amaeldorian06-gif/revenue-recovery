/**
 * Reply matching, in the order the prompt fixes — headers, thread, then
 * sender+subject. Never classify sentiment: a match means "a human answered",
 * and the user decides what it means.
 */
import { normalizeSubject } from './normalize.ts';

export interface MailCandidate {
  opportunityId: string;
  contactEmail: string;
  /** Every provider_message_id we ever sent for this dossier. */
  sentProviderIds: string[];
  /** Thread ids of our own outgoing messages. */
  threadIds: string[];
  normalizedSubject: string;
}

export interface MatchableMessage {
  from: string;
  headers: {
    inReplyTo?: string | null;
    references?: string[];
  };
  threadId?: string | null;
  subject: string;
}

const emailOf = (from: string): string => {
  const m = /<([^>]+)>/.exec(from);
  return (m?.[1] ?? from).trim().toLowerCase();
};

const splitIds = (value: string | string[] | null | undefined): string[] =>
  (Array.isArray(value) ? value : [value ?? ''])
    .flatMap((v: string) => v.split(/[\s,]+/))
    .map((v: string) => v.trim().replace(/^<|>$/g, ''))
    .filter((v: string) => v.length > 0);

export type MatchReason = 'in_reply_to' | 'thread' | 'sender_subject';

export interface MatchResult {
  opportunityId: string;
  reason: MatchReason;
}

/** Gmail sends `<id@host>` and replies reference it bare — both sides are
 *  normalised so the intersection never depends on bracket style. */
const canonicalId = (value: string): string => value.trim().replace(/^<|>$/g, '');

export function matchReply(message: MatchableMessage, candidates: MailCandidate[]): MatchResult | null {
  const from = emailOf(message.from);
  const refs = [
    ...splitIds(message.headers.inReplyTo),
    ...splitIds(message.headers.references),
  ];
  const refSet = new Set(refs.map(canonicalId));

  // 1 — In-Reply-To / References contains a stored provider_message_id.
  if (refSet.size > 0) {
    for (const c of candidates) {
      if (c.sentProviderIds.some((id) => refSet.has(canonicalId(id)))) {
        return { opportunityId: c.opportunityId, reason: 'in_reply_to' };
      }
    }
  }

  // 2 — same provider thread id.
  if (message.threadId) {
    for (const c of candidates) {
      if (c.threadIds.includes(message.threadId)) {
        return { opportunityId: c.opportunityId, reason: 'thread' };
      }
    }
  }

  // 3 — sender equals the contact email AND the subject matches. Two clients
  // called "Facturation" must not collide: the sender check is not optional.
  const subject = normalizeSubject(message.subject);
  for (const c of candidates) {
    if (c.contactEmail === from && c.normalizedSubject === subject && subject !== '') {
      return { opportunityId: c.opportunityId, reason: 'sender_subject' };
    }
  }

  return null;
}
