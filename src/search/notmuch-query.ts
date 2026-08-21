import type { SearchCriteria } from './criteria.types.js';

/* --------
 * Types
 * -------- */

export interface NotmuchQueryOptions {
  /**
   * Accounts to search in, when the criteria name a folder but not an account. It is needed to
   * qualify `folder:`, which in notmuch is always relative to the database root.
   */
  accountIds?: readonly string[] | undefined;
  /**
   * Folder path inside the mirror, per account id, already resolved against the filesystem by
   * `resolveMirrorFolder`. The IMAP path the caller asked for is not the path the mirror uses:
   * `INBOX.Archive.Suppliers` on the server is `Archive/Suppliers` on disk, and a `folder:` term
   * built on the former matches nothing at all.
   */
  mirrorFolders?: ReadonlyMap<string, string> | undefined;
}

/* --------
 * Constants
 * -------- */

/**
 * Characters notmuch (Xapian) reads as syntax. A term containing any of them has to be quoted, or a
 * search for `invoice (2026)` turns into a boolean query and returns something else.
 */
const NEEDS_QUOTING = /[\s():"*]/;

/* --------
 * Helpers
 * -------- */

/**
 * Quotes a term for notmuch. Inner double quotes are doubled, which is the escape form Xapian
 * accepts.
 */
export function quoteTerm(term: string): string {
  const trimmed = term.trim();

  if (trimmed.length === 0) {
    return '""';
  }

  if (!NEEDS_QUOTING.test(trimmed)) {
    return trimmed;
  }

  return `"${trimmed.replace(/"/g, '""')}"`;
}

/**
 * `YYYY-MM-DD` out of an ISO date. notmuch accepts this form in `date:` ranges.
 */
function toDateStamp(iso: string): string | undefined {
  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed.toISOString().slice(0, 10);
}

/* --------
 * Implementation
 * -------- */

/**
 * Translates the criteria into a notmuch query.
 *
 * `hasAttachment` is not expressed here: notmuch does not index it without extra configuration, and a
 * query that pretends to filter on it is worse than a filter applied afterwards.
 *
 * On scoping, two properties of notmuch verified in practice and far from obvious:
 *
 * - `folder:` is a boolean term and accepts no wildcards: qualifying it with a double asterisk finds
 *   nothing. Recursive search is expressed only with `path:`, and only with the glob in **trailing**
 *   position: a leading glob (to find a folder under any account) does not work.
 * - `folder:` wants the full path from the database root, that is `<accountId>/<folder>`.
 *   `folder:INBOX` on its own finds nothing.
 * - the folder in that path is the **mirror's**, not the server's. mbsync explodes the remote
 *   hierarchy into directories, so the IMAP path has to be resolved first and is passed in already
 *   resolved through `mirrorFolders`.
 *
 * Hence the signature: translating a folder criterion needs the ids of the accounts in scope, because
 * the same folder has to be looked for beneath each one.
 */
export function buildNotmuchQuery(criteria: SearchCriteria, options: NotmuchQueryOptions = {}): string {
  const terms: string[] = [];

  // ---- Scope
  const accountIds = criteria.accountId !== undefined
    ? [criteria.accountId]
    : (options.accountIds ?? []);

  if (criteria.folder !== undefined) {
    // The folder has to be qualified with the account: without the prefix `folder:` finds nothing.
    // Only the accounts whose mirror actually holds the folder contribute a term. An account where it
    // could not be resolved is left out on purpose: `executeSearch` refuses the notmuch engine when
    // that leaves nothing to search, so the fallback is a server search rather than an empty answer.
    const qualified: string[] = [];

    for (const accountId of accountIds) {
      const mirrorFolder = options.mirrorFolders?.get(accountId) ?? criteria.folder;

      qualified.push(`folder:${quoteTerm(`${accountId}/${mirrorFolder}`)}`);
    }

    if (qualified.length === 1) {
      terms.push(qualified[0] ?? '');
    } else if (qualified.length > 1) {
      terms.push(`(${qualified.join(' or ')})`);
    }
  } else if (criteria.accountId !== undefined) {
    terms.push(`path:${quoteTerm(`${criteria.accountId}/**`)}`);
  }

  // ---- Headers
  if (criteria.from !== undefined) {
    terms.push(`from:${quoteTerm(criteria.from)}`);
  }

  if (criteria.to !== undefined) {
    terms.push(`to:${quoteTerm(criteria.to)}`);
  }

  if (criteria.subject !== undefined) {
    terms.push(`subject:${quoteTerm(criteria.subject)}`);
  }

  // ---- Full text
  if (criteria.text !== undefined) {
    terms.push(quoteTerm(criteria.text));
  }

  // ---- Date range
  const since = criteria.since === undefined ? undefined : toDateStamp(criteria.since);
  const before = criteria.before === undefined ? undefined : toDateStamp(criteria.before);

  if (since !== undefined || before !== undefined) {
    terms.push(`date:${since ?? ''}..${before ?? ''}`);
  }

  // ---- Flags
  if (criteria.isUnread === true) {
    terms.push('tag:unread');
  }

  if (criteria.isUnread === false) {
    terms.push('not tag:unread');
  }

  if (criteria.isFlagged === true) {
    terms.push('tag:flagged');
  }

  // ---- Return
  return terms.length === 0 ? '*' : terms.join(' and ');
}
