import { describe, expect, it } from 'vitest';

import { parseHeaderBlock } from '#imap/headers';

/* --------
 * parseHeaderBlock
 * -------- */

describe('parseHeaderBlock', () => {
  it('lowercases the names, because header names are case-insensitive', () => {
    expect(parseHeaderBlock('Subject: hello\r\nFROM: a@b.it')).toEqual({
      subject: ['hello'],
      from:    ['a@b.it'],
    });
  });

  /*
   * RFC 5322 §2.2.3: a long header is folded across lines, continuations starting with whitespace. A
   * naive line-by-line split loses everything after the first line — and `List-Unsubscribe`, which is
   * long by nature, is exactly the header that gets folded.
   */
  it('rejoins a folded header', () => {
    const raw = [
      'List-Unsubscribe: <https://example.com/u/very/long/path>,',
      '\t<mailto:unsub@example.com>',
      'Subject: after',
    ].join('\r\n');

    expect(parseHeaderBlock(raw)['list-unsubscribe']).toEqual([
      '<https://example.com/u/very/long/path>, <mailto:unsub@example.com>',
    ]);
    expect(parseHeaderBlock(raw)['subject']).toEqual(['after']);
  });

  it('keeps every occurrence of a repeated header', () => {
    const raw = 'Received: from a\r\nReceived: from b\r\nSubject: x';

    expect(parseHeaderBlock(raw)['received']).toEqual(['from a', 'from b']);
  });

  it('stops at the empty line that separates headers from the body', () => {
    const raw = 'Subject: real\r\n\r\nSubject: this is body text, not a header';

    expect(parseHeaderBlock(raw)['subject']).toEqual(['real']);
  });

  it('handles LF-only line endings, which some servers return', () => {
    expect(parseHeaderBlock('Subject: unix\nFrom: a@b.it')['subject']).toEqual(['unix']);
  });

  it('skips a line with no colon instead of inventing a header', () => {
    expect(parseHeaderBlock('garbage line\r\nSubject: ok')).toEqual({ subject: ['ok'] });
  });

  it('preserves colons inside a value', () => {
    expect(parseHeaderBlock('List-Id: name <list.example.com>\r\nX-Url: https://a.b/c')['x-url'])
      .toEqual(['https://a.b/c']);
  });
});
