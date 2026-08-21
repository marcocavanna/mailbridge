import { describe, expect, it } from 'vitest';

import { buildNotmuchQuery, quoteTerm } from '#search/notmuch-query';

/* --------
 * quoteTerm
 * -------- */

describe('quoteTerm', () => {
  it('leaves a simple term untouched', () => {
    expect(quoteTerm('invoice')).toBe('invoice');
  });

  it('quotes a term containing spaces', () => {
    expect(quoteTerm('credit note')).toBe('"credit note"');
  });

  it('quotes the characters Xapian reads as syntax', () => {
    expect(quoteTerm('invoice (2026)')).toBe('"invoice (2026)"');
    expect(quoteTerm('account*')).toBe('"account*"');
    expect(quoteTerm('a:b')).toBe('"a:b"');
  });

  it('doubles inner quotes instead of breaking on them', () => {
    expect(quoteTerm('the "real" total')).toBe('"the ""real"" total"');
  });

  it('does not produce an empty query out of an empty term', () => {
    expect(quoteTerm('   ')).toBe('""');
  });
});

/* --------
 * buildNotmuchQuery
 * -------- */

describe('buildNotmuchQuery', () => {
  it('searches everything when no criteria are given', () => {
    expect(buildNotmuchQuery({ limit: 10 })).toBe('*');
  });

  it('joins criteria with and', () => {
    const query = buildNotmuchQuery({ from: 'mario@x.it', subject: 'quote', limit: 10 });

    expect(query).toBe('from:mario@x.it and subject:quote');
  });

  /*
   * These cases come from a real mistake: the first version used `folder:"<id>/**"` for account scope,
   * which in notmuch returns zero results without signalling anything — `folder:` is a boolean term and
   * ignores wildcards. The forms below were verified against a real notmuch database.
   */
  it('uses path: for recursive account scope, not folder:', () => {
    const query = buildNotmuchQuery({ accountId: 'work', limit: 10 });

    expect(query).toBe('path:"work/**"');
    expect(query).not.toContain('folder:');
  });

  it('qualifies the folder with the account, because folder: is relative to the database root', () => {
    const query = buildNotmuchQuery(
      { accountId: 'work', folder: 'INBOX.Sent', limit: 10 },
      { accountIds: ['work'], mirrorFolders: new Map([['work', 'Sent']]) },
    );

    expect(query).toBe('folder:work/Sent');
  });

  /**
   * The second half of the same mistake. `folder:` needs the path of the mirror, not the path of the
   * server: mbsync explodes the remote hierarchy, so `INBOX.Archive.Suppliers` is `Archive/Suppliers`
   * on disk. Built on the IMAP path the term matches nothing, and a search that finds nothing reads
   * exactly like an empty folder.
   */
  it('uses the mirror path, not the IMAP path', () => {
    const query = buildNotmuchQuery(
      { accountId: 'work', folder: 'INBOX.Archive.Suppliers', limit: 10 },
      { accountIds: ['work'], mirrorFolders: new Map([['work', 'Archive/Suppliers']]) },
    );

    expect(query).toBe('folder:work/Archive/Suppliers');
    expect(query).not.toContain('INBOX.Archive');
  });

  it('translates the folder per account, since the same one can sit at a different depth', () => {
    const query = buildNotmuchQuery(
      { folder: 'INBOX.Sent', limit: 10 },
      { accountIds: ['one', 'two'], mirrorFolders: new Map([['one', 'Sent'], ['two', 'INBOX/Sent']]) },
    );

    expect(query).toBe('(folder:one/Sent or folder:two/INBOX/Sent)');
  });

  /**
   * Unresolved, the raw path is kept: it is narrow rather than wrong-in-the-other-direction, and
   * `executeSearch` never reaches it — it falls back to a server search instead of reporting an empty
   * folder.
   */
  it('falls back to the requested path when the mirror could not resolve it', () => {
    const query = buildNotmuchQuery({ accountId: 'work', folder: 'INBOX.Ghost', limit: 10 });

    expect(query).toBe('folder:work/INBOX.Ghost');
  });

  it('quotes a folder containing spaces, which unquoted would split the term', () => {
    const query = buildNotmuchQuery({ accountId: 'work', folder: 'Posta inviata', limit: 10 });

    expect(query).toBe('folder:"work/Posta inviata"');
  });

  it('expands the folder across every account in scope when no account is given', () => {
    const query = buildNotmuchQuery(
      { folder: 'INBOX', limit: 10 },
      { accountIds: ['one', 'two'], mirrorFolders: new Map([['one', 'INBOX'], ['two', 'INBOX']]) },
    );

    expect(query).toBe('(folder:one/INBOX or folder:two/INBOX)');
  });

  it('produces no folder term when it knows of no account', () => {
    expect(buildNotmuchQuery({ folder: 'INBOX', limit: 10 })).toBe('*');
  });

  it('lets an explicit folder win over recursive scope instead of combining them', () => {
    const query = buildNotmuchQuery({ accountId: 'work', folder: 'INBOX', limit: 10 });

    expect(query).toBe('folder:work/INBOX');
  });

  it('translates a date range open on the right', () => {
    const query = buildNotmuchQuery({ since: '2026-01-15T00:00:00Z', limit: 10 });

    expect(query).toBe('date:2026-01-15..');
  });

  it('translates a date range open on the left', () => {
    const query = buildNotmuchQuery({ before: '2026-08-01T00:00:00Z', limit: 10 });

    expect(query).toBe('date:..2026-08-01');
  });

  it('ignores an unparseable date instead of producing a broken range', () => {
    expect(buildNotmuchQuery({ since: 'not-a-date', limit: 10 })).toBe('*');
  });

  it('tells read and unread apart', () => {
    expect(buildNotmuchQuery({ isUnread: true, limit: 10 })).toBe('tag:unread');
    expect(buildNotmuchQuery({ isUnread: false, limit: 10 })).toBe('not tag:unread');
  });

  it('does not express hasAttachment in the query, because notmuch does not index it', () => {
    expect(buildNotmuchQuery({ hasAttachment: true, limit: 10 })).toBe('*');
  });

  it('quotes free text containing syntax characters', () => {
    expect(buildNotmuchQuery({ text: 'balance (final)', limit: 10 })).toBe('"balance (final)"');
  });
});
