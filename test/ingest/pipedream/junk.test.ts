/**
 * The junk gate (U9 approach 3).
 *
 * Two properties, and only the second one is about accuracy:
 *
 *   1. **A hidden verdict must reach U4's quarantine seam.** That seam is what
 *      makes a newsletter cost nothing — a quarantined page is written, hidden
 *      from reads, and never embedded. A classifier that returns a pretty
 *      verdict which no caller turns into a marker is a gate that runs *after*
 *      the meter, which is the one thing this unit is not allowed to be.
 *   2. **A warned verdict must NOT reach it.** Warned-but-searchable is the
 *      other marker: a receipt is worth finding, so it is embedded and
 *      retrievable, and quarantining it would silently drop a class of mail out
 *      of `recall`.
 *
 * The direction of the unknown is deliberate and stated here rather than left
 * to be inferred: an item with no headers reads **clean**. Hiding mail nobody
 * classified is how a brain silently stops answering about real correspondence,
 * which is a worse failure than paying for a newsletter.
 */

import { describe, expect, test } from 'bun:test';

import {
  JUNK_MARKER_BULK,
  JUNK_MARKER_TRANSACTIONAL,
  classifyJunk,
  quarantineMarkerFor,
} from '../../../src/ingest/junk.ts';

describe('the two markers', () => {
  test('a newsletter with List-Unsubscribe lands quarantined-hidden', () => {
    const verdict = classifyJunk({
      headers: {
        'List-Unsubscribe': '<https://news.example.test/u/123>',
        'List-Id': 'weekly <weekly.example.test>',
      },
      from: 'weekly@news.example.test',
      subject: 'Your Tuesday roundup',
    });

    expect(verdict.visibility).toBe('hidden');
    expect(verdict.marker).toBe(JUNK_MARKER_BULK);
    // The half that costs money: this is what U4 is handed.
    expect(quarantineMarkerFor(verdict)).toBe(JUNK_MARKER_BULK);
  });

  test('a receipt lands warned-but-searchable — and is NOT quarantined', () => {
    const verdict = classifyJunk({
      headers: { 'Auto-Submitted': 'auto-generated' },
      from: 'no-reply@store.example.test',
      subject: 'Your receipt from Acme Store (order 4417)',
    });

    expect(verdict.visibility).toBe('warned');
    expect(verdict.marker).toBe(JUNK_MARKER_TRANSACTIONAL);
    // Warned is searchable. Handing this to the quarantine seam would hide it.
    expect(quarantineMarkerFor(verdict)).toBeNull();
  });

  test('a payment record survives the sender writing it the way senders write it', () => {
    // Measured on a 10,036-page production mailbox: the original pattern
    // required `payment` to be IMMEDIATELY followed by received/confirmed/
    // failed, and matched **zero** of the 75 quarantined pages whose subjects
    // were transactional on their face. These two shapes are what real senders
    // actually write, and both were hidden — never embedded, so "what did I pay
    // for that" could not be answered.
    for (const subject of [
      'We received your Intuit subscription payment!',
      '(PS1) payment successful',
      'Payment declined for your subscription',
    ]) {
      const verdict = classifyJunk({
        headers: { 'list-unsubscribe': '<mailto:unsub@biller.example.test>' },
        from: 'no-reply@biller.example.test',
        subject,
      });
      expect(verdict.visibility).toBe('warned');
      // The half that matters: it reaches the corpus rather than the quarantine.
      expect(quarantineMarkerFor(verdict)).toBeNull();
    }
  });

  test('the widened gap stays inside one clause, so a newsletter is still junk', () => {
    // The cap of three words is what stops `payment` and a verb anywhere in a
    // long marketing subject from reading as a receipt. Without it, the first
    // of these would be warned.
    for (const subject of [
      'We received a lot of interest this quarter — read our take on payment rails',
      'Renewal Payment Update',
      'The Receipts Layer',
      '[Past Due] Avoid collections with a payment plan',
    ]) {
      const verdict = classifyJunk({
        headers: { 'list-unsubscribe': '<mailto:unsub@news.example.test>' },
        from: 'news@news.example.test',
        subject,
      });
      expect(verdict.visibility).toBe('hidden');
    }
  });

  test('a bulk message that is also transactional is warned, not hidden', () => {
    // Order confirmations from large senders carry list headers too. Hiding one
    // loses the only record of a purchase; warning keeps it findable.
    const verdict = classifyJunk({
      headers: {
        'list-unsubscribe': '<mailto:unsub@store.example.test>',
        'auto-submitted': 'auto-generated',
      },
      from: 'orders@store.example.test',
      subject: 'Order 8891 has shipped',
    });

    expect(verdict.visibility).toBe('warned');
    expect(quarantineMarkerFor(verdict)).toBeNull();
  });
});

describe('what stays clean', () => {
  test('ordinary correspondence is clean', () => {
    const verdict = classifyJunk({
      headers: { 'Message-Id': '<abc@mail.example.test>' },
      from: 'a-founder@widget-co.example',
      subject: 'Re: term sheet questions',
    });

    expect(verdict.visibility).toBeNull();
    expect(verdict.marker).toBeNull();
    expect(quarantineMarkerFor(verdict)).toBeNull();
  });

  test('a personal message relayed from a no-reply address is clean', () => {
    // A machine sender ALONE says nothing: plenty of ordinary mail is relayed
    // from one. Warning on it would mark a whole mailbox as junk-ish, and the
    // marker then means nothing when a real receipt arrives.
    const verdict = classifyJunk({
      from: 'noreply@relay.example.test',
      subject: 'Re: the plan for next week',
    });
    expect(verdict.visibility).toBeNull();
  });

  test('an item with no headers at all is clean, not hidden', () => {
    // Calendar events and Drive files carry no mail headers. Reading the
    // absence as junk would quarantine every non-mail source wholesale.
    expect(classifyJunk({}).visibility).toBeNull();
    expect(classifyJunk({ headers: {} }).visibility).toBeNull();
  });

  test('header lookup is case-insensitive', () => {
    const upper = classifyJunk({ headers: { 'LIST-UNSUBSCRIBE': '<x>' } });
    const lower = classifyJunk({ headers: { 'list-unsubscribe': '<x>' } });
    expect(upper.visibility).toBe('hidden');
    expect(lower.visibility).toBe('hidden');
  });
});

describe('the other bulk signals', () => {
  test('Precedence: bulk hides', () => {
    expect(classifyJunk({ headers: { Precedence: 'bulk' } }).visibility).toBe('hidden');
  });

  test('a promotions label hides', () => {
    expect(classifyJunk({ labels: ['CATEGORY_PROMOTIONS', 'INBOX'] }).visibility).toBe('hidden');
  });

  test('a spam label hides even with no other signal', () => {
    expect(classifyJunk({ labels: ['SPAM'] }).visibility).toBe('hidden');
  });

  test('every verdict names the signals it fired on', () => {
    const verdict = classifyJunk({
      headers: { 'List-Unsubscribe': '<x>', Precedence: 'bulk' },
    });
    expect(verdict.signals).toContain('list-unsubscribe');
    expect(verdict.signals).toContain('precedence-bulk');
  });

  test('a header value that is empty is not a signal', () => {
    // A provider that returns every header with an empty value would otherwise
    // quarantine the whole mailbox.
    expect(classifyJunk({ headers: { 'List-Unsubscribe': '   ' } }).visibility).toBeNull();
  });
});
