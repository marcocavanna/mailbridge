import { withMailbox } from './connection.js';
import { isBulkMail, normalizeListId, parseUnsubscribeHeader } from './bulk-mail.js';
import { parseHeaderBlock } from './headers.js';

import { parseAddressHeader } from '#shared/address';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';
import type { UnsubscribeTarget } from './bulk-mail.js';
import type { ImapFlow } from 'imapflow';

/* --------
 * Constants
 * -------- */

/**
 * Headers that identify bulk mail, per RFC 2369 (`List-*`) and RFC 8058 (one-click unsubscribe).
 *
 * These are what makes a newsletter recognizable. Sender and subject do not: a personal email that
 * happens to discuss newsletters would match, and a newsletter sent from a plain address would not.
 */
const BULK_HEADERS = [
  'list-unsubscribe',
  'list-unsubscribe-post',
  'list-id',
  'list-post',
  'precedence',
] as const;

const ENVELOPE_HEADERS = ['from', 'subject', 'date'] as const;

/** Ceiling on how many messages a single scan inspects. Scanning is read-only, but not free. */
const MAX_SCAN_MESSAGES = 2000;

/* --------
 * Types
 * -------- */

export interface SubscriptionGroup {
  /** Grouping key: the `List-Id` when present, otherwise the sender address. */
  key: string;
  /** `List-Id` as declared, when there is one. */
  listId: string | undefined;
  senderAddress: string;
  senderName: string | undefined;
  messageCount: number;
  unreadCount: number;
  /** Subject of the most recent message, to make the list recognizable. */
  latestSubject: string | undefined;
  latestDate: string | undefined;
  /** uids in the scanned folder, ready to hand to a bulk operation. */
  uids: number[];
  unsubscribe: UnsubscribeTarget[];
  /**
   * The sender declared RFC 8058 one-click support. It means unsubscribing is a single POST rather than
   * a page to navigate — it does **not** mean it is safe to trigger automatically.
   */
  supportsOneClick: boolean;
}

export type ScanStrategy = 'header-search' | 'local-filter';

export interface ScanSubscriptionsResult {
  folder: string;
  /**
   * How the candidates were found. `header-search` means the server filtered them; `local-filter` means
   * it could not, and messages were inspected here.
   */
  strategy: ScanStrategy;
  /** Messages inspected. */
  scanned: number;
  /** Of those, how many looked like bulk mail. */
  bulkMessages: number;
  groups: SubscriptionGroup[];
  /** True when the scan stopped at the ceiling and the folder holds more. */
  truncated: boolean;
}

export interface ScanSubscriptionsOptions {
  folder: string;
  /** Only messages newer than this ISO date. */
  since?: string | undefined;
  limit?: number | undefined;
}

/* --------
 * Helpers — candidate selection
 * -------- */

/**
 * Picks the messages to inspect.
 *
 * First it asks the server for messages carrying a `List-Unsubscribe` header, which is the cheap path.
 * Not every IMAP server implements HEADER search on an arbitrary field, and one that does not returns an
 * empty set rather than an error — indistinguishable from "no newsletters here". So an empty result
 * falls back to scanning recent messages and deciding locally: slower, but it answers the question
 * instead of answering it wrongly. The strategy used is reported to the caller.
 */
async function selectCandidates(
  client: ImapFlow,
  options: { since: string | undefined; limit: number },
): Promise<{ uids: number[]; strategy: ScanStrategy }> {
  const sinceDate = options.since === undefined ? undefined : new Date(options.since);

  const byHeader = await client.search(
    sinceDate === undefined
      ? { header: { 'list-unsubscribe': true } }
      : { header: { 'list-unsubscribe': true }, since: sinceDate },
    { uid: true },
  );

  const takeNewest = (found: number[]): number[] => (
    [...found].sort((left, right) => right - left).slice(0, options.limit)
  );

  if (byHeader !== false && byHeader.length > 0) {
    return { uids: takeNewest([...byHeader]), strategy: 'header-search' };
  }

  const everything = await client.search(
    sinceDate === undefined ? { all: true } : { since: sinceDate },
    { uid: true },
  );

  return {
    uids:     everything === false ? [] : takeNewest([...everything]),
    strategy: 'local-filter',
  };
}

/* --------
 * Implementation
 * -------- */

/**
 * Scans a folder for bulk mail and groups it by mailing list.
 *
 * The result is built to be acted on: every group carries the uids of its messages, so archiving one
 * newsletter is a single bulk move, plus the unsubscribe links found in its headers.
 *
 * **The links are reported, never opened.** Fetching an unsubscribe URL confirms that the address is
 * live and read, which on unsolicited mail is precisely what the sender wants to learn. Deciding to
 * follow one belongs to the account owner.
 */
export async function scanSubscriptions(
  account: Account,
  options: ScanSubscriptionsOptions,
): Promise<ScanSubscriptionsResult> {
  // ---- Options deconstruct
  const { folder, since } = options;
  const limit = Math.min(Math.max(options.limit ?? MAX_SCAN_MESSAGES, 1), MAX_SCAN_MESSAGES);

  return withMailbox(account, folder, async (client) => {
    // ---- Candidates
    const { uids, strategy } = await selectCandidates(client, { since, limit });

    if (uids.length === 0) {
      return { folder, strategy, scanned: 0, bulkMessages: 0, groups: [], truncated: false };
    }

    // ---- Fetch headers only: no bodies, so scanning thousands of messages stays cheap
    const groups = new Map<string, SubscriptionGroup>();
    const newestUid = new Map<string, number>();
    let scanned = 0;
    let bulkMessages = 0;

    for await (const entry of client.fetch(
      uids.join(','),
      {
        uid:     true,
        flags:   true,
        headers: [...BULK_HEADERS, ...ENVELOPE_HEADERS],
      },
      { uid: true },
    )) {
      scanned += 1;

      if (entry.headers === undefined) {
        continue;
      }

      const headers = parseHeaderBlock(entry.headers.toString('utf8'));

      if (!isBulkMail(headers)) {
        continue;
      }

      bulkMessages += 1;

      // ---- Sender
      const sender = parseAddressHeader(headers['from']?.[0])[0];
      const senderAddress = sender?.address.toLowerCase() ?? 'unknown';
      const listId = normalizeListId(headers['list-id']?.[0]);
      const key = listId ?? senderAddress;

      // ---- Unsubscribe
      const unsubscribe = (headers['list-unsubscribe'] ?? []).flatMap((value) => parseUnsubscribeHeader(value));
      const supportsOneClick = (headers['list-unsubscribe-post'] ?? []).some((value) => (
        value.toLowerCase().includes('one-click')
      ));

      const flags = entry.flags === undefined ? [] : [...entry.flags];
      const isUnread = !flags.includes('\\Seen');
      const existing = groups.get(key);

      if (existing === undefined) {
        groups.set(key, {
          key,
          listId,
          senderAddress,
          senderName:    sender?.name,
          messageCount:  1,
          unreadCount:   isUnread ? 1 : 0,
          latestSubject: headers['subject']?.[0],
          latestDate:    headers['date']?.[0],
          uids:          [entry.uid],
          unsubscribe,
          supportsOneClick,
        });

        newestUid.set(key, entry.uid);

        continue;
      }

      existing.messageCount += 1;
      existing.unreadCount += isUnread ? 1 : 0;
      existing.uids.push(entry.uid);
      existing.supportsOneClick = existing.supportsOneClick || supportsOneClick;

      if (existing.unsubscribe.length === 0 && unsubscribe.length > 0) {
        existing.unsubscribe = unsubscribe;
      }

      // A higher uid is a more recent message: its subject is the useful label for the group.
      if (entry.uid > (newestUid.get(key) ?? 0)) {
        newestUid.set(key, entry.uid);
        existing.latestSubject = headers['subject']?.[0] ?? existing.latestSubject;
        existing.latestDate = headers['date']?.[0] ?? existing.latestDate;
      }
    }

    // ---- Result mapping
    const ordered = [...groups.values()].sort((left, right) => right.messageCount - left.messageCount);

    logger.debug('subscription scan completed', {
      accountId: account.id,
      folder,
      strategy,
      scanned,
      bulkMessages,
      groups: ordered.length,
    });

    return { folder, strategy, scanned, bulkMessages, groups: ordered, truncated: scanned >= limit };
  });
}
