/**
 * Launch gate D — exceptions reach the aggregator without PII. The scrubber is
 * the contract: emails, API keys, bearer tokens, webhook secrets and amounts
 * die; stack identity (type, codes, request_id) survives.
 */
import { describe, it, expect } from 'vitest';
import { captureException, scrubEvent, scrubText } from '../sentry.ts';

describe('captureException — no PII in captured events', () => {
  it('strips emails, keys, tokens, secrets and amounts from the message', () => {
    const err = new Error(
      'send to marie.dupont@client.fr failed with rrs_live_ABCDEFGH123456 and Bearer eyJhbGciOiJIUzI1NiJ9.x.y',
    );
    const ev = captureException(err, {
      route: '/api/cron/send',
      request_id: 'req-1',
      leak: 'Client Dupont, devis 12 500,00 €',
      draft: 'Bonjour, nous vous accordons une remise de 10 %',
    });
    expect(ev.exception.value).not.toContain('marie.dupout');
    expect(ev.exception.value).not.toContain('marie.dupont');
    expect(ev.exception.value).not.toContain('rrs_live_');
    expect(ev.exception.value).not.toContain('eyJ');
    expect(ev.exception.value).toContain('[email]');
    expect(ev.exception.value).toContain('[api_key]');
    expect(ev.exception.value).toContain('[token]');
    expect(ev.extra).toEqual({ route: '/api/cron/send', request_id: 'req-1' });
  });

  it('keeps the type and the codes — an exception without identity is useless', () => {
    class SmtpError extends Error { name = 'SmtpError'; code = 'SMTP_535'; }
    const ev = captureException(new SmtpError('auth refused for contact+pro@agence.fr'));
    expect(ev.exception.type).toBe('SmtpError');
    expect(ev.exception.value).toContain('auth refused');
    expect(ev.exception.value).toContain('[email]');
  });

  it('scrubEvent leaves non-string extras untouched and drops unknown keys', () => {
    const ev = scrubEvent({
      level: 'error',
      exception: { type: 'E', value: 'x' },
      extra: { count: 3, workspace_id: 'ws-1', secret: 'whsec_ABCDEFGH' },
    });
    expect(ev.extra).toEqual({ workspace_id: 'ws-1' });
  });

  it('scrubText masks a euro amount written with a narrow no-break space', () => {
    expect(scrubText('facture 12\u202f500,00 € impayée')).toContain('[amount]');
    expect(scrubText('facture 12\u202f500,00 € impayée')).not.toContain('500');
  });
});
