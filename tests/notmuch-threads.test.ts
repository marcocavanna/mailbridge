import { describe, expect, it } from 'vitest';

import { buildThreadQuery, toNotmuchId } from '#search/notmuch-threads';

/* --------
 * toNotmuchId
 * -------- */

describe('toNotmuchId', () => {
  it('strips the angle brackets IMAP delivers', () => {
    expect(toNotmuchId('<abc-123@example.com>')).toBe('abc-123@example.com');
  });

  it('leaves a bare id untouched', () => {
    expect(toNotmuchId('abc-123@example.com')).toBe('abc-123@example.com');
  });

  it('drops the characters that would break the nested query', () => {
    expect(toNotmuchId('<we"ird {id}@example.com>')).toBe('weirdid@example.com');
  });
});

/* --------
 * buildThreadQuery
 * -------- */

describe('buildThreadQuery', () => {
  it('quotes the braces', () => {
    // Unquoted, Xapian stops at the first term and fails with `missing }`. A one-id chain would
    // still work, so the regression would only show on real conversations.
    expect(buildThreadQuery(['a@x', 'b@y'])).toBe('thread:"{id:a@x or id:b@y}"');
  });

  it('quotes them for a single id too, so the shape never differs', () => {
    expect(buildThreadQuery(['a@x'])).toBe('thread:"{id:a@x}"');
  });
});
