import { runNotmuch } from './notmuch-exec.js';
import { buildNotmuchQuery } from './notmuch-query.js';

import { isTombstoneFile, locateInMirror } from '#mirror/paths';
import { parseAddressHeader } from '#shared/address';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { SearchCriteria } from './criteria.types.js';
import type { NotmuchQueryOptions } from './notmuch-query.js';
import type { SearchHit } from './search.types.js';

/* --------
 * Types
 * -------- */

interface NotmuchHeaders {
  Subject?: string;
  From?: string;
  To?: string;
  Cc?: string;
  Date?: string;
}

interface NotmuchMessage {
  id?: string;
  filename?: string | string[];
  timestamp?: number;
  tags?: string[];
  headers?: NotmuchHeaders;
}

/* --------
 * Helpers — parsing
 * -------- */

/**
 * `notmuch show` output is nested: a list of threads, each a list of messages with their own
 * replies. This flattens it in visit order.
 */
function flattenShowOutput(node: unknown, collected: NotmuchMessage[]): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      flattenShowOutput(child, collected);
    }

    return;
  }

  if (node === null || typeof node !== 'object') {
    return;
  }

  const candidate = node as NotmuchMessage & { id?: unknown };

  if (typeof candidate.id === 'string') {
    collected.push(candidate);
  }
}

function toFilenameList(filename: string | string[] | undefined): string[] {
  if (typeof filename === 'string') {
    return [filename];
  }

  return Array.isArray(filename) ? filename : [];
}

/**
 * Does the live copy sit in one of the folders the caller asked for?
 *
 * Applied only when a folder criterion is present, and only against folders that resolved in the
 * mirror: an account whose folder could not be located contributes no constraint, because
 * `executeSearch` sends that case to the server instead.
 */
function isInScopedFolder(
  location: { accountId: string; folder: string } | undefined,
  options: NotmuchQueryOptions,
): boolean {
  const scoped = options.mirrorFolders;

  if (scoped === undefined || scoped.size === 0) {
    return true;
  }

  if (location === undefined) {
    return false;
  }

  const expected = scoped.get(location.accountId);

  return expected === undefined || expected === location.folder;
}

/**
 * The live copy to read account and folder from, among the copies **inside the search scope**.
 *
 * A message moved between folders keeps its `Message-Id`, so the index holds one message with the
 * live file and the tombstone of the folder it left: taking the first file at random attributes the
 * message to whichever folder notmuch happens to list first, usually the INBOX it was filed out of.
 *
 * notmuch also keeps one message per `Message-Id` across mirrors. The same message can sit in two of
 * them, typically a mailbox moved to a new server with the old mirror still on disk, and the query
 * matches because one of its files is in scope while the first file listed is not. Reading the location
 * off that file would attribute the result to the wrong account and folder.
 *
 * With a folder criterion the copy in that folder wins, since an account can hold the same message in
 * two of its folders. `undefined` when no live copy is in scope: gone from the server, or present only
 * in a mirror outside the search.
 */
export function pickScopedLocation(
  filenames: readonly string[],
  scopeAccountIds: readonly string[],
  options: NotmuchQueryOptions,
  hasFolderCriterion: boolean,
): { filename: string; location: ReturnType<typeof locateInMirror> } | undefined {
  const live = filenames
    .filter((candidate) => !isTombstoneFile(candidate))
    .map((filename) => ({ filename, location: locateInMirror(filename) }));

  const inScope = scopeAccountIds.length === 0
    ? live
    : live.filter((entry) => entry.location !== undefined && scopeAccountIds.includes(entry.location.accountId));

  if (!hasFolderCriterion) {
    return inScope[0];
  }

  return inScope.find((entry) => isInScopedFolder(entry.location, options));
}

/* --------
 * Implementation
 * -------- */

/**
 * Searches the local mirror through notmuch.
 *
 * `hasAttachment` is applied here rather than in the query, because notmuch does not index it without
 * dedicated configuration: the filter relies on the `attachment` tag when present.
 */
export async function searchWithNotmuch(
  criteria: SearchCriteria,
  options: NotmuchQueryOptions = {},
): Promise<{ hits: SearchHit[]; query: string }> {
  // ---- Query build
  const query = buildNotmuchQuery(criteria, options);

  const raw = await runNotmuch([
    'show',
    '--format=json',
    '--body=false',
    '--entire-thread=false',
    query,
  ]);

  // ---- Parse
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new MailbridgeError('search_failed', 'notmuch output could not be parsed.', { cause });
  }

  const messages: NotmuchMessage[] = [];

  flattenShowOutput(parsed, messages);

  // ---- Result mapping
  const hits: SearchHit[] = [];

  for (const message of messages) {
    // ---- Location, read off a live copy inside the scope rather than an arbitrary one
    // The `folder:` term alone is not enough: a message filed out of the INBOX still has its
    // tombstone there, so the term matches the folder it left as well as the one it lives in.
    const picked = pickScopedLocation(
      toFilenameList(message.filename),
      criteria.accountId === undefined ? (options.accountIds ?? []) : [criteria.accountId],
      options,
      criteria.folder !== undefined,
    );

    if (picked === undefined) {
      // No live copy in scope: gone from the server, or present only in a mirror outside the search.
      continue;
    }

    const { location } = picked;
    const tags = message.tags ?? [];
    const hasAttachment = tags.includes('attachment');

    if (criteria.hasAttachment === true && !hasAttachment) {
      continue;
    }

    hits.push({
      accountId:  location?.accountId ?? criteria.accountId ?? 'unknown',
      folder:     location?.folder,
      messageId:  message.id,
      subject:    message.headers?.Subject ?? '(no subject)',
      from:       parseAddressHeader(message.headers?.From),
      to:         parseAddressHeader(message.headers?.To),
      date:       message.timestamp === undefined ? undefined : new Date(message.timestamp * 1000).toISOString(),
      isUnread:   tags.includes('unread'),
      isFlagged:  tags.includes('flagged'),
      hasAttachment,
      uid:        undefined,
    });
  }

  // ---- Sort and cap
  hits.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));

  logger.debug('notmuch search completed', { query, found: hits.length });

  return { hits: hits.slice(0, criteria.limit), query };
}
