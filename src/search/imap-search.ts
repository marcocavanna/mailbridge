import { withMailbox } from '#imap/connection';
import { listFolders } from '#imap/folders';
import { mapAddresses } from '#shared/address';
import { logger } from '#shared/logger';

import type { SearchCriteria } from './criteria.types.js';
import type { SearchHit } from './search.types.js';
import type { Account } from '#config/accounts.schema';
import type { SearchObject } from 'imapflow';

/* --------
 * Helpers
 * -------- */

/**
 * Translates the criteria into an imapflow `SearchObject`.
 *
 * `hasAttachment` is not expressible in IMAP SEARCH and is ignored here: the filter is applied after
 * the fetch, on the MIME structure.
 */
function buildImapQuery(criteria: SearchCriteria): SearchObject {
  const query: SearchObject = {};

  if (criteria.from !== undefined) {
    query.from = criteria.from;
  }

  if (criteria.to !== undefined) {
    query.to = criteria.to;
  }

  if (criteria.subject !== undefined) {
    query.subject = criteria.subject;
  }

  if (criteria.text !== undefined) {
    query.body = criteria.text;
  }

  if (criteria.since !== undefined) {
    query.since = new Date(criteria.since);
  }

  if (criteria.before !== undefined) {
    query.before = new Date(criteria.before);
  }

  if (criteria.isUnread !== undefined) {
    query.seen = !criteria.isUnread;
  }

  if (criteria.isFlagged !== undefined) {
    query.flagged = criteria.isFlagged;
  }

  return Object.keys(query).length === 0 ? { all: true } : query;
}

function describeQuery(query: SearchObject): string {
  return JSON.stringify(query);
}

/* --------
 * Implementation
 * -------- */

/**
 * Searches one folder and fetches the most recent matches, at most `limit`. Within a folder uids grow
 * with arrival, so the highest are the newest; across folders they mean nothing, which is why the caller
 * merges on dates.
 */
async function searchFolder(
  account: Account,
  folder: string,
  query: SearchObject,
  criteria: SearchCriteria,
): Promise<SearchHit[]> {
  return withMailbox(account, folder, async (client) => {
    const uids = await client.search(query, { uid: true });

    if (uids === false || uids.length === 0) {
      return [];
    }

    // ---- Fetch the most recent matches only
    const selected = [...uids].sort((left, right) => right - left).slice(0, criteria.limit);
    const collected: SearchHit[] = [];

    for await (const entry of client.fetch(
      selected.join(','),
      {
        uid:           true,
        envelope:      true,
        flags:         true,
        bodyStructure: true,
      },
      { uid: true },
    )) {
      const flags = entry.flags === undefined ? [] : [...entry.flags];
      const structure = entry.bodyStructure;
      const hasAttachment = structure?.childNodes?.some((child) => child.disposition === 'attachment') === true;

      if (criteria.hasAttachment === true && !hasAttachment) {
        continue;
      }

      collected.push({
        accountId: account.id,
        folder,
        messageId: entry.envelope?.messageId,
        subject:   entry.envelope?.subject ?? '(no subject)',
        from:      mapAddresses(entry.envelope?.from),
        to:        mapAddresses(entry.envelope?.to),
        date:      entry.envelope?.date === undefined ? undefined : entry.envelope.date.toISOString(),
        isUnread:  !flags.includes('\\Seen'),
        isFlagged: flags.includes('\\Flagged'),
        hasAttachment,
        uid:       entry.uid,
      });
    }

    return collected;
  });
}

/* --------
 * Implementation
 * -------- */

export interface ImapSearchResult {
  hits: SearchHit[];
  query: string;
  /** The folders actually searched, so the result can say where it looked. */
  folders: string[];
  /** Folders that could not be searched, with the reason. The rest of the search still counts. */
  failures: string[];
}

/**
 * Searches live over IMAP: always up to date, slower than the index.
 *
 * IMAP SEARCH runs inside one selected folder, so a search without a folder criterion visits **every**
 * selectable folder of the account, one after the other on the account's connection. Searching the inbox
 * alone would answer a question about the whole mailbox with a fraction of it. A folder that fails is
 * reported and skipped, not allowed to sink the others.
 */
export async function searchWithImap(account: Account, criteria: SearchCriteria): Promise<ImapSearchResult> {
  // ---- Query Build
  const query = buildImapQuery(criteria);
  const folders = criteria.folder !== undefined
    ? [criteria.folder]
    : (await listFolders(account)).filter((folder) => folder.isSelectable).map((folder) => folder.path);

  // ---- Search
  const hits: SearchHit[] = [];
  const failures: string[] = [];

  for (const folder of folders) {
    try {
      hits.push(...await searchFolder(account, folder, query, criteria));
    } catch (cause) {
      // A folder chosen explicitly is the whole search: its failure is the answer, not a footnote.
      if (criteria.folder !== undefined) {
        throw cause;
      }

      failures.push(`${folder}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  // ---- Result Mapping
  hits.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));

  logger.debug('IMAP search completed', { accountId: account.id, folders: folders.length, found: hits.length });

  return { hits: hits.slice(0, criteria.limit), query: describeQuery(query), folders, failures };
}

/**
 * Resolves a message's uid from its `Message-Id`. It is the bridge between a search result that came
 * from the mirror — which has no uid — and the operations that need one.
 */
export async function findUidByMessageId(
  account: Account,
  folder: string,
  messageId: string,
): Promise<number | undefined> {
  return withMailbox(account, folder, async (client) => {
    const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });

    if (uids === false || uids.length === 0) {
      return undefined;
    }

    return uids[uids.length - 1];
  });
}
