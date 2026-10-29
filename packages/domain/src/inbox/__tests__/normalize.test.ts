import { describe, it, expect } from 'vitest';
import {
  normalizeSubject, truncateSnippet, isBounce, isAutoReply, detectOptOut,
  filterHeaders, SNIPPET_MAX,
} from '../normalize.ts';

describe('normalizeSubject', () => {
  it('strips every French and English prefix iteration', () => {
    expect(normalizeSubject('Re: RE: Rép: Devis')).toBe('devis');
    expect(normalizeSubject('Fwd: Fw: TR: devis')).toBe('devis');
  });
  it('keeps letters, digits, drops the rest', () => {
    expect(normalizeSubject('FACTURATION !!! (rappel) n°2026')).toBe('facturationrappeln2026');
  });
  it('empty stays empty — the sender+subject rule refuses empty subjects', () => {
    expect(normalizeSubject('')).toBe('');
    expect(normalizeSubject('Re:')).toBe('');
  });
});

describe('truncateSnippet', () => {
  it('never exceeds 1 000 chars and marks the cut', () => {
    const body = 'x'.repeat(5_000);
    const out = truncateSnippet(body);
    expect(out.length).toBe(SNIPPET_MAX);
    expect(out.endsWith('…')).toBe(true);
  });
  it('collapses whitespace', () => {
    expect(truncateSnippet('  a\n\n  b\tc  ')).toBe('a b c');
  });
});

describe('isBounce — three signals, any of them decides', () => {
  it('mailer-daemon sender', () => {
    expect(isBounce({ from: 'Mailer Daemon <mailer-daemon@mx.client.fr>' })).toBe(true);
  });
  it('multipart/report content type', () => {
    expect(isBounce({ from: 'x@y.fr', contentType: 'multipart/report; report-type=delivery-status' })).toBe(true);
  });
  it('French and English failure subjects', () => {
    expect(isBounce({ from: 'x@y.fr', subject: 'Non remis : votre dossier' })).toBe(true);
    expect(isBounce({ from: 'x@y.fr', subject: 'Undelivered Mail Returned to Sender' })).toBe(true);
  });
  it('a normal reply is not a bounce', () => {
    expect(isBounce({ from: 'Marie <marie@client.fr>', subject: 'Re: Devis' })).toBe(false);
  });
});

describe('isAutoReply — a machine is not a client', () => {
  it('Auto-Submitted other than "no" is a machine', () => {
    expect(isAutoReply({ 'auto-submitted': 'auto-replied' })).toBe(true);
    expect(isAutoReply({ 'auto-submitted': 'no' })).toBe(false);
  });
  it('X-Autoreply and vacation markers count', () => {
    expect(isAutoReply({ 'x-autoreply': 'yes' })).toBe(true);
    expect(isAutoReply({ 'x-autorespond': 'Vacation' })).toBe(true);
  });
  it('no marker: a human', () => {
    expect(isAutoReply({})).toBe(false);
  });
});

describe('detectOptOut — false positive acceptable, true negative forbidden', () => {
  it('finds the French keywords', () => {
    expect(detectOptOut('Merci de me désinscrire de votre liste.')).toBe('désinscrire');
    expect(detectOptOut('veuillez ne plus me contacter')).toBe('ne plus me contacter');
  });
  it('finds the English ones and bare STOP', () => {
    expect(detectOptOut('Please unsubscribe me')).toBe('unsubscribe');
    expect(detectOptOut('STOP')).toBe('stop');
  });
  it('a long French acceptance is not an opt-out', () => {
    expect(detectOptOut('Bonjour, votre proposition nous intéresse, appelons-nous demain.')).toBeNull();
  });
  it('checks subject AND body', () => {
    expect(detectOptOut('Re: Devis', 'Désabonnement demandé')).toBe('désabonner');
  });
});

describe('filterHeaders — only the three ids ever persist', () => {
  it('keeps In-Reply-To, References, Message-ID', () => {
    const out = filterHeaders({
      'In-Reply-To': '<a@x>',
      references: '<a@x> <b@x>',
      'Message-ID': '<c@x>',
      'X-Secret-Header': 'nope',
    });
    expect(out.inReplyTo).toBe('<a@x>');
    expect(out.references).toEqual(['<a@x>', '<b@x>']);
    expect(out.messageId).toBe('<c@x>');
    expect(JSON.stringify(out)).not.toContain('nope');
  });
});
