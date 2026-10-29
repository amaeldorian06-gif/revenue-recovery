/**
 * The provider boundary: one call, a sandbox redirect that cannot leak, and a
 * failure that is reported rather than retried in a loop.
 */
import { describe, it, expect } from 'vitest';
import { executeSend, SANDBOX_PREFIX } from '../send.ts';
import { MemoryEmailProvider } from '../providers/memory.ts';
import type { SendState } from '../stopRules.ts';

const NOW = new Date('2026-10-25T09:00:00Z');
const state: SendState = {
  arm: 'treatment', opportunityStatus: 'open', touchCount: 0,
  lastTouchAt: null, replyReceivedAt: null, contactOptedOut: false,
  workspaceStatus: 'active', sendsToday: 3,
};
const action = {
  actionId: '11111111-2222-3333-4444-555555555555',
  subject: 'Votre avis sur la refonte',
  body: 'Bonjour Camille, …',
  recipientEmail: 'camille@merlot.fr',
};
const sandboxOff = { enabled: false, ownerEmail: 'owner@studio.fr' };

describe('executeSend', () => {
  it('sends once, with the action UUID as idempotency key', async () => {
    const provider = new MemoryEmailProvider();
    const res = await executeSend({ action, state, provider, sandbox: sandboxOff, now: NOW });

    expect(res.status).toBe('sent');
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.idempotencyKey).toBe(action.actionId);
    expect(provider.sent[0]!.to).toBe('camille@merlot.fr');
  });

  it('cancels before calling the provider when a stop rule fires', async () => {
    const provider = new MemoryEmailProvider();
    const res = await executeSend({
      action, state: { ...state, arm: 'holdout' }, provider, sandbox: sandboxOff, now: NOW,
    });
    expect(res.status).toBe('cancelled');
    expect(res).toMatchObject({ code: 'HOLDOUT' });
    expect(provider.sent).toHaveLength(0);
  });

  it('in sandbox, the client is never the recipient and the subject is marked', async () => {
    const provider = new MemoryEmailProvider();
    const res = await executeSend({
      action, state, provider, now: NOW,
      sandbox: { enabled: true, ownerEmail: 'owner@studio.fr' },
    });
    expect(res.status).toBe('sent');
    expect(provider.sent[0]!.to).toBe('owner@studio.fr');
    expect(provider.sent[0]!.subject.startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(res).toMatchObject({ sandbox: true });
  });

  it('reports a provider failure instead of throwing', async () => {
    const provider = new MemoryEmailProvider();
    provider.failOnce('bounce', 'mailbox unavailable');
    const res = await executeSend({ action, state, provider, sandbox: sandboxOff, now: NOW });
    expect(res.status).toBe('failed');
    expect(res).toMatchObject({ errorCode: 'bounce' });
  });

  it('refuses a dossier with no e-mail address, before calling anyone', async () => {
    const provider = new MemoryEmailProvider();
    const res = await executeSend({
      action: { ...action, recipientEmail: null }, state, provider, sandbox: sandboxOff, now: NOW,
    });
    expect(res.status).toBe('failed');
    expect(provider.sent).toHaveLength(0);
  });
});
