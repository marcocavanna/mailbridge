import { describe, expect, it } from 'vitest';

import { isBulkMail, normalizeListId, parseUnsubscribeHeader } from '#imap/bulk-mail';

/* --------
 * parseUnsubscribeHeader
 * -------- */

describe('parseUnsubscribeHeader', () => {
  it('extracts both an http and a mailto target, per RFC 2369', () => {
    const targets = parseUnsubscribeHeader('<https://example.com/unsub?id=42>, <mailto:leave@example.com>');

    expect(targets).toEqual([
      { kind: 'http', value: 'https://example.com/unsub?id=42' },
      { kind: 'mailto', value: 'mailto:leave@example.com' },
    ]);
  });

  it('tolerates values without angle brackets, which occur in the wild', () => {
    expect(parseUnsubscribeHeader('https://example.com/unsub')).toEqual([
      { kind: 'http', value: 'https://example.com/unsub' },
    ]);
  });

  it('drops anything that is neither http nor mailto rather than guessing', () => {
    expect(parseUnsubscribeHeader('<ftp://example.com/unsub>, <javascript:alert(1)>')).toEqual([]);
  });

  it('returns an empty list for an empty header', () => {
    expect(parseUnsubscribeHeader('')).toEqual([]);
  });

  it('keeps the URL byte for byte, without normalizing it', () => {
    const url = 'https://example.com/u?a=1&b=%20x';

    expect(parseUnsubscribeHeader(`<${url}>`)[0]?.value).toBe(url);
  });
});

/* --------
 * isBulkMail
 * -------- */

describe('isBulkMail', () => {
  /*
   * The point of this test: recognition rests on the `List-*` headers, not on sender or subject. A
   * personal email that happens to mention newsletters must not match, or "archive all newsletters"
   * would file real correspondence.
   */
  it('does not treat a personal message about newsletters as bulk mail', () => {
    expect(isBulkMail({
      from:    ['Anna <anna@example.com>'],
      subject: ['Re: which newsletters do you subscribe to?'],
    })).toBe(false);
  });

  it('recognizes List-Unsubscribe', () => {
    expect(isBulkMail({ 'list-unsubscribe': ['<mailto:x@y.it>'] })).toBe(true);
  });

  it('recognizes List-Id', () => {
    expect(isBulkMail({ 'list-id': ['news <news.example.com>'] })).toBe(true);
  });

  it('recognizes a bulk Precedence', () => {
    expect(isBulkMail({ precedence: ['bulk'] })).toBe(true);
    expect(isBulkMail({ precedence: ['list'] })).toBe(true);
  });

  it('ignores a Precedence that does not mean bulk', () => {
    expect(isBulkMail({ precedence: ['urgent'] })).toBe(false);
  });
});

/* --------
 * normalizeListId
 * -------- */

describe('normalizeListId', () => {
  it('takes the identifier out of the friendly form', () => {
    expect(normalizeListId('Weekly News <news.example.com>')).toBe('news.example.com');
  });

  it('accepts a bare identifier', () => {
    expect(normalizeListId('news.example.com')).toBe('news.example.com');
  });

  it('lowercases it, so the same list groups together', () => {
    expect(normalizeListId('<News.Example.COM>')).toBe('news.example.com');
  });

  it('returns undefined for an absent or empty value', () => {
    expect(normalizeListId(undefined)).toBeUndefined();
    expect(normalizeListId('   ')).toBeUndefined();
  });
});
