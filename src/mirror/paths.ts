import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';

import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

/** Root of every mirror. Outside the repository, and never committed. */
const DEFAULT_MAIL_ROOT = join(homedir(), 'Mail');

const MAILDIR_LEAVES = new Set(['cur', 'new', 'tmp']);

/** The one folder name IMAP fixes by specification, and the one mbsync maps explicitly. */
const INBOX_NAME = 'INBOX';

/** The hierarchy delimiters seen in practice: `.` on Aruba and most cPanel hosts, `/` elsewhere. */
const REMOTE_DELIMITERS = ['.', '/'] as const;

/* --------
 * Implementation — roots
 * -------- */

export function resolveMailRoot(): string {
  const override = process.env['MAILBRIDGE_MAIL_ROOT'];

  return override !== undefined && override.length > 0 ? override : DEFAULT_MAIL_ROOT;
}

export function resolveMaildirPath(account: Account): string {
  return account.mirror.maildirPath ?? join(resolveMailRoot(), account.id);
}

/* --------
 * Implementation — IMAP path to mirror path
 * -------- */

/**
 * The local folder paths the mirror could hold for an IMAP folder, in decreasing likelihood.
 *
 * mailbridge writes the `mbsyncrc` itself, so it owns the geometry: `SubFolders Verbatim` with an
 * explicit `Inbox`, which means the remote hierarchy delimiter becomes a directory separator and the
 * leading `INBOX` of a nested folder disappears. `INBOX.Archive.TipoStampa` on the server is
 * `Archive/TipoStampa` on disk.
 *
 * What mailbridge does not own is the delimiter, which belongs to the server. Rather than guess it,
 * the candidates cover both forms and the caller keeps whichever exists.
 *
 * This is not cosmetic. A `folder:` term built on the IMAP path matches nothing in notmuch, and a
 * search that finds nothing reads exactly like an empty folder.
 */
export function mirrorFolderCandidates(imapFolder: string): string[] {
  const trimmed = imapFolder.trim().replace(/^\/+/, '').replace(/\/+$/, '');

  if (trimmed.length === 0) {
    return [];
  }

  const candidates = new Set<string>([trimmed]);

  for (const delimiter of REMOTE_DELIMITERS) {
    const segments = trimmed.split(delimiter).filter((segment) => segment.length > 0);

    if (segments.length < 2) {
      continue;
    }

    if (segments[0] === INBOX_NAME) {
      candidates.add(segments.slice(1).join('/'));
    }

    candidates.add(segments.join('/'));
  }

  return [...candidates];
}

/**
 * Where an IMAP folder actually lives in the mirror, or `undefined` when it is not there.
 *
 * Resolution is against the filesystem rather than a rule, so a delimiter the configuration never
 * mentions cannot produce a wrong answer: at worst it produces no answer, and a caller that gets
 * `undefined` is expected to fall back to the server instead of reporting an empty result.
 */
export async function resolveMirrorFolder(account: Account, imapFolder: string): Promise<string | undefined> {
  const base = resolveMaildirPath(account);

  for (const candidate of mirrorFolderCandidates(imapFolder)) {
    if (await isMaildir(join(base, candidate))) {
      return candidate;
    }
  }

  return undefined;
}

async function isMaildir(path: string): Promise<boolean> {
  try {
    return (await stat(join(path, 'cur'))).isDirectory();
  } catch {
    return false;
  }
}

/* --------
 * Implementation — mirror path to account and folder
 * -------- */

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

/**
 * Is this maildir file a tombstone, flagged deleted but never expunged?
 *
 * mbsync marks a message that left the remote folder with the `T` flag and, under `Expunge None`,
 * leaves the file where it is. notmuch keeps indexing it, and because a moved message keeps its
 * `Message-Id` the index ends up holding one message with two filenames: the live copy and the
 * tombstone of the folder it came from. Reading the wrong one attributes the message to a folder it
 * left months ago.
 */
export function isTombstoneFile(filePath: string): boolean {
  const flags = basename(filePath).split(':2,')[1];

  return flags !== undefined && flags.includes('T');
}
