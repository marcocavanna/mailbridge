import { describe, expect, it } from 'vitest';

import { isBulkHeaders, locateMessage } from '#search/awaiting-reply';

/* --------
 * locateMessage
 * -------- */

describe('locateMessage', () => {
  it('recovers the folder from a Maildir path', () => {
    expect(locateMessage('/Users/x/Mail/work/INBOX/cur/123:2,S', 'work')).toBe('INBOX');
  });

  it('keeps a nested folder whole', () => {
    expect(locateMessage('/Users/x/Mail/work/INBOX.Clients.Acme/new/9:2,', 'work')).toBe('INBOX.Clients.Acme');
  });

  it('handles a folder path with separators', () => {
    expect(locateMessage('/Users/x/Mail/work/Clients/Acme/cur/9:2,S', 'work')).toBe('Clients/Acme');
  });

  it('returns undefined for a path outside this account', () => {
    expect(locateMessage('/Users/x/Mail/other/INBOX/cur/1:2,S', 'work')).toBeUndefined();
  });

  it('returns undefined for a path with no maildir leaf', () => {
    expect(locateMessage('/Users/x/Mail/work/INBOX/1:2,S', 'work')).toBeUndefined();
  });

  it('returns undefined when there is no filename', () => {
    expect(locateMessage(undefined, 'work')).toBeUndefined();
  });
});

/* --------
 * isBulkHeaders
 * -------- */

describe('isBulkHeaders', () => {
  /*
   * notmuch returns header names capitalized, IMAP fetches return them lowercase. Matching only one
   * casing would silently classify every newsletter as personal mail, and the report would fill with
   * threads nobody is waiting on.
   */
  it('matches header names whatever their casing', () => {
    expect(isBulkHeaders({ 'List-Unsubscribe': '<mailto:x@y.it>' })).toBe(true);
    expect(isBulkHeaders({ 'list-unsubscribe': '<mailto:x@y.it>' })).toBe(true);
  });

  it('recognizes a bulk Precedence', () => {
    expect(isBulkHeaders({ Precedence: 'bulk' })).toBe(true);
  });

  it('does not classify ordinary mail as bulk', () => {
    expect(isBulkHeaders({ From: 'anna@example.com', Subject: 'about the newsletter' })).toBe(false);
  });

  it('handles absent headers', () => {
    expect(isBulkHeaders(undefined)).toBe(false);
    expect(isBulkHeaders({})).toBe(false);
  });
});
