import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isTombstoneFile, locateInMirror, mirrorFolderCandidates } from '#mirror/paths';

/* --------
 * mirrorFolderCandidates
 * -------- */

describe('mirrorFolderCandidates', () => {
  it('explodes an Aruba path and drops the INBOX prefix', () => {
    // What mbsync actually writes to disk for `INBOX.Archive.Suppliers`.
    expect(mirrorFolderCandidates('INBOX.Archive.Suppliers')).toContain('Archive/Suppliers');
  });

  it('offers the exploded form before the deeper one', () => {
    const candidates = mirrorFolderCandidates('INBOX.Archive.Suppliers');

    expect(candidates.indexOf('Archive/Suppliers')).toBeLessThan(candidates.indexOf('INBOX/Archive/Suppliers'));
  });

  it('leaves the INBOX itself alone', () => {
    expect(mirrorFolderCandidates('INBOX')).toEqual(['INBOX']);
  });

  it('handles a server whose delimiter is a slash', () => {
    expect(mirrorFolderCandidates('INBOX/Sent')).toContain('Sent');
  });

  it('keeps a top-level folder that is not under the INBOX', () => {
    expect(mirrorFolderCandidates('Archive.2024')).toContain('Archive/2024');
  });

  it('returns nothing for an empty path instead of a bare separator', () => {
    expect(mirrorFolderCandidates('   ')).toEqual([]);
    expect(mirrorFolderCandidates('/')).toEqual([]);
  });
});

/* --------
 * isTombstoneFile
 * -------- */

describe('isTombstoneFile', () => {
  it('recognizes the T flag mbsync leaves behind', () => {
    // A message filed out of the INBOX: mbsync flags it deleted and, under `Expunge None`, keeps it.
    expect(isTombstoneFile('/Mail/acct/INBOX/cur/1787139333.4658.host,U=4658:2,ST')).toBe(true);
    expect(isTombstoneFile('/Mail/acct/INBOX/cur/1787139333.4657.host,U=4657:2,RST')).toBe(true);
  });

  it('does not mistake other flags for it', () => {
    expect(isTombstoneFile('/Mail/acct/Archive/cur/1787213548.1475.host,U=230:2,S')).toBe(false);
    expect(isTombstoneFile('/Mail/acct/Sent/cur/1787139364.7788.host,U=1507:2,RS')).toBe(false);
  });

  it('treats a file with no flag block as live', () => {
    expect(isTombstoneFile('/Mail/acct/INBOX/new/1787139333.4658.host')).toBe(false);
  });
});

/* --------
 * locateInMirror
 * -------- */

describe('locateInMirror', () => {
  const root = '/tmp/mailbridge-test-mail';

  beforeEach(() => {
    process.env['MAILBRIDGE_MAIL_ROOT'] = root;
  });

  afterEach(() => {
    delete process.env['MAILBRIDGE_MAIL_ROOT'];
  });

  it('recovers account and folder', () => {
    expect(locateInMirror(`${root}/acct/Sent/cur/123.host:2,S`)).toEqual({ accountId: 'acct', folder: 'Sent' });
  });

  it('recovers a nested folder', () => {
    expect(locateInMirror(`${root}/acct/Archive/Suppliers/cur/123.host:2,S`))
      .toEqual({ accountId: 'acct', folder: 'Archive/Suppliers' });
  });

  it('ignores a path outside the mirror', () => {
    expect(locateInMirror('/elsewhere/acct/Sent/cur/123.host:2,S')).toBeUndefined();
  });
});
