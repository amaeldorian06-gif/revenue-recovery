import { describe, it, expect } from 'vitest';
import { matchReply, type MailCandidate, type MatchableMessage } from '../match.ts';

/**
 * Criterion 1 — the twelve fixtures. Every one asserts the matched
 * opportunity id or null, and none of them reads a network or a database:
 * matching is a pure function, which is what makes the traps testable.
 */

const A: MailCandidate = {
  opportunityId: 'opp-A',
  contactEmail: 'marie.dupont@client-a.fr',
  sentProviderIds: ['<sent-a-1@rros>', '<sent-a-2@rros>'],
  threadIds: ['thread-A'],
  normalizedSubject: 'devisremboursementformation',
};
const B: MailCandidate = {
  opportunityId: 'opp-B',
  contactEmail: 'service.facturation@client-b.fr',
  sentProviderIds: ['<sent-b-1@rros>'],
  threadIds: ['thread-B'],
  normalizedSubject: 'facturation',
};
const C: MailCandidate = {
  opportunityId: 'opp-C',
  contactEmail: 'facturation@client-c.fr',
  sentProviderIds: [],
  threadIds: [],
  normalizedSubject: 'facturation',
};
const CANDIDATES = [A, B, C];

const msg = (over: Partial<MatchableMessage>): MatchableMessage => ({
  from: 'Marie Dupont <marie.dupont@client-a.fr>',
  headers: {},
  subject: 'Re: Devis remboursement formation',
  ...over,
});

describe('the twelve matching fixtures', () => {
  it('1 — In-Reply-To contains a stored sent provider id', () => {
    const m = msg({ headers: { inReplyTo: '<sent-a-1@rros>' } });
    expect(matchReply(m, CANDIDATES)).toEqual({ opportunityId: 'opp-A', reason: 'in_reply_to' });
  });

  it('2 — References chain (middle of a long thread) matches too', () => {
    const m = msg({ headers: { references: ['<other@x>', '<sent-a-2@rros>', '<yet@y>'] } });
    expect(matchReply(m, CANDIDATES)?.opportunityId).toBe('opp-A');
    expect(matchReply(m, CANDIDATES)?.reason).toBe('in_reply_to');
  });

  it('3 — same Gmail thread id matches even without headers', () => {
    const m = msg({ threadId: 'thread-B', headers: {} });
    expect(matchReply(m, CANDIDATES)).toEqual({ opportunityId: 'opp-B', reason: 'thread' });
  });

  it('4 — French « Rép: » stripped, sender equal → subject-only match', () => {
    const m = msg({
      from: 'facturation@client-c.fr',
      subject: 'Rép: Facturation',
      headers: {},
    });
    expect(matchReply(m, CANDIDATES)).toEqual({ opportunityId: 'opp-C', reason: 'sender_subject' });
  });

  it('5 — RE:, casing, punctuation and accents of the subject are normalised away', () => {
    const m = msg({
      from: 'facturation@client-c.fr',
      subject: 'RE: Fwd: FACTURATION !!!',
    });
    expect(matchReply(m, CANDIDATES)?.opportunityId).toBe('opp-C');
  });

  it('6 — same subject but a DIFFERENT sender does not match (the "Facturation" trap)', () => {
    const m = msg({ from: 'quelquun@ailleurs.fr', subject: 'Re: Facturation' });
    expect(matchReply(m, CANDIDATES)).toBeNull();
  });

  it('7 — a forwarded message (Fwd:) with no headers does not invent a match', () => {
    const m = msg({
      from: 'marie.dupont@client-a.fr',
      subject: 'Fwd: Devis remboursement formation — voir avec Truc',
    });
    // The normalised subject differs → no match, even from the right sender.
    expect(matchReply(m, CANDIDATES)).toBeNull();
  });

  it('8 — a message to a colleague in cc does not match the dossier', () => {
    const m = msg({
      from: 'marie.dupont@client-a.fr',
      subject: 'Question RH: Devis remboursement formation',
      headers: {},
    });
    expect(matchReply(m, CANDIDATES)).toBeNull();
  });

  it('9 — empty headers, different thread, wrong subject → null', () => {
    const m = msg({ subject: 'Bonjour', threadId: 'thread-unknown' });
    expect(matchReply(m, CANDIDATES)).toBeNull();
  });

  it('10 — angle brackets around message ids are tolerated both ways', () => {
    const m = msg({ headers: { inReplyTo: 'sent-b-1@rros' } });
    expect(matchReply(m, CANDIDATES)?.opportunityId).toBe('opp-B');
  });

  it('11 — a message whose id-match belongs to a closed dossier is simply not a candidate', () => {
    // opp-A was closed and removed from candidates; the same reply must return null.
    const closed = msg({ headers: { inReplyTo: '<sent-a-1@rros>' } });
    expect(matchReply(closed, [B, C])).toBeNull();
  });

  it('12 — the first rule wins: header match beats a thread that points elsewhere', () => {
    const m = msg({
      threadId: 'thread-B',
      headers: { inReplyTo: '<sent-a-2@rros>' },
    });
    expect(matchReply(m, CANDIDATES)).toEqual({ opportunityId: 'opp-A', reason: 'in_reply_to' });
  });
});
