import { withMailbox } from '#imap/connection';
import { resolveSpecialFolder } from '#imap/folders';
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
 * Searches live over IMAP. This is the fallback when the mirror is unavailable: slower and with less
 * full-text capability, but always up to date.
 */
export async function searchWithImap(
  account: Account,
  criteria: SearchCriteria,
): Promise<{ hits: SearchHit[]; query: string }> {
  // ---- Query build
  const folder = criteria.folder ?? (await resolveSpecialFolder(account, 'inbox'));
  const query = buildImapQuery(criteria);

  const hits = await withMailbox(account, folder, async (client) => {
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

  logger.debug('IMAP search completed', { accountId: account.id, folder, found: hits.length });

  return { hits, query: describeQuery(query) };
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
