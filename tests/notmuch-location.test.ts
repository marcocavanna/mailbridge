import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pickScopedLocation } from '#search/notmuch';

/* --------
 * Fixture
 * -------- */

const ROOT = '/tmp/mailbridge-mail-root';

beforeEach(() => {
  process.env['MAILBRIDGE_MAIL_ROOT'] = ROOT;
});

afterEach(() => {
  delete process.env['MAILBRIDGE_MAIL_ROOT'];
});

const oldMirror = `${ROOT}/office-old/Archive/cur/1700000000.1_2.host,U=7:2,S`;
const newMirror = `${ROOT}/office/Archivio/cur/1790000000.1_2.host,U=9:2,S`;

/* --------
 * Behaviour
 * -------- */

describe('location of a message held by two mirrors', () => {
  it('reads it off the copy of the account in scope, not off the first file listed', () => {
    const picked = pickScopedLocation([oldMirror, newMirror], ['office'], {}, false);

    expect(picked?.location).toEqual({ accountId: 'office', folder: 'Archivio' });
  });

  it('drops a message whose only copies are outside the scope', () => {
    expect(pickScopedLocation([oldMirror], ['office'], {}, false)).toBeUndefined();
  });

  it('prefers the copy in the requested folder when an account holds it twice', () => {
    const inbox = `${ROOT}/office/INBOX/cur/1790000001.1_2.host,U=3:2,S`;
    const picked = pickScopedLocation(
      [inbox, newMirror],
      ['office'],
      { mirrorFolders: new Map([['office', 'Archivio']]) },
      true,
    );

    expect(picked?.location?.folder).toBe('Archivio');
  });
});
