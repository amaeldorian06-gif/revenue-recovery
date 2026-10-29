/** SSRF guard: private ranges and plain HTTP are undeliverable, loopback only in dev. */
import { describe, it, expect } from 'vitest';
import { isDeliverableUrl } from './ssrf.ts';

describe('ssrf guard on webhook urls', () => {
  it('accepts a public https url', () => {
    expect(isDeliverableUrl('https://client.example.com/webhooks/rros')).toEqual({ allowed: true });
  });

  it('requires https outside the dev loopback allowance', () => {
    expect(isDeliverableUrl('http://client.example.com/hook').reason).toBe('scheme');
  });

  it('blocks loopback, metadata, link-local and private ranges', () => {
    for (const url of [
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://172.16.0.9/hook',
      'https://[::1]/hook',
      'https://metadata.google.internal/computeMetadata/v1',
    ]) {
      expect(isDeliverableUrl(url).allowed).toBe(false);
    }
  });

  it('the dev allowance opens 127.0.0.1 and localhost ONLY', () => {
    expect(isDeliverableUrl('http://127.0.0.1:3000/api/dev/hook-receiver', { allowInsecureLoopback: true }).allowed).toBe(true);
    expect(isDeliverableUrl('http://localhost:3000/hook', { allowInsecureLoopback: true }).allowed).toBe(true);
    expect(isDeliverableUrl('http://10.0.0.5/hook', { allowInsecureLoopback: true }).allowed).toBe(false);
    expect(isDeliverableUrl('https://169.254.169.254/x', { allowInsecureLoopback: true }).allowed).toBe(false);
  });

  it('refuses credentials in the url and non-http schemes', () => {
    expect(isDeliverableUrl('https://user:pass@example.com/hook').reason).toBe('credentials');
    expect(isDeliverableUrl('file:///etc/passwd').reason).toBe('scheme');
    expect(isDeliverableUrl('not a url').reason).toBe('parse');
  });
});
