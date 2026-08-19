import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

/** Root of every mirror. Outside the repository, and never committed. */
const DEFAULT_MAIL_ROOT = join(homedir(), 'Mail');

const MAILDIR_LEAVES = new Set(['cur', 'new', 'tmp']);

/* --------
 * Implementation
 * -------- */

export function resolveMailRoot(): string {
  const override = process.env['MAILBRIDGE_MAIL_ROOT'];

  return override !== undefined && override.length > 0 ? override : DEFAULT_MAIL_ROOT;
}

export function resolveMaildirPath(account: Account): string {
  return account.mirror.maildirPath ?? join(resolveMailRoot(), account.id);
}

/**
 * Derives account and folder from the path of a file in the mirror.
 *
 * The geometry is `<mailRoot>/<accountId>/<folder…>/{cur,new}/<file>`, so the folder is everything
 * between the account id and the Maildir leaf. Returns `undefined` for a path outside the mirror:
 * that is unexpected data, not an error to propagate.
 */
export function locateInMirror(filePath: string): { accountId: string; folder: string } | undefined {
  const root = resolveMailRoot();

  if (!filePath.startsWith(`${root}${sep}`)) {
    return undefined;
  }

  const segments = filePath.slice(root.length + 1).split(sep);
  const accountId = segments[0];

  if (accountId === undefined || segments.length < 3) {
    return undefined;
  }

  // ---- Strip the maildir leaf and the file name
  const middle = segments.slice(1, -1);

  while (middle.length > 0) {
    const last = middle[middle.length - 1];

    if (last !== undefined && MAILDIR_LEAVES.has(last)) {
      middle.pop();
      continue;
    }

    break;
  }

  return { accountId, folder: middle.join('/') };
}
