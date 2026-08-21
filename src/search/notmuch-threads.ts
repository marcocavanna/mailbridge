import { runNotmuch } from './notmuch-exec.js';

import { isTombstoneFile, locateInMirror } from '#mirror/paths';
import { logger } from '#shared/logger';

/* --------
 * Constants
 * -------- */

/**
 * How many `Message-Id`s of a chain are handed to notmuch. A long forwarded chain can carry dozens,
 * and they all resolve to the same handful of threads: past this the query grows without adding
 * anything.
 */
const MAX_CHAIN_IDS = 25;

/* --------
 * Helpers
 * -------- */

/**
 * `Message-Id` in the form notmuch wants.
 *
 * IMAP and mailparser hand it over inside angle brackets, which `id:` does not accept. The
 * characters Xapian reads as syntax are dropped rather than escaped: inside the quoted nested query
 * built below there is no escape form that survives, and a `Message-Id` containing one of them is
 * malformed to begin with.
 */
export function toNotmuchId(messageId: string): string {
  return messageId.trim().replace(/^</, '').replace(/>$/, '').replace(/["{}()\s]/g, '');
}

/**
 * Every file of every thread any of these ids belongs to.
 *
 * `thread:{...}` is the nested form: it takes an inner query, resolves it to the threads that match,
 * and returns everything in them. One round trip instead of listing thread ids and feeding them back.
 *
 * The braces **must be quoted** once the inner query contains a space. Unquoted, Xapian stops at the
 * first term and fails with `missing }`, so a chain of one id works and a real chain of fifteen
 * silently degrades to a folder-local thread. It needs notmuch 0.32 or newer; an older one errors,
 * which the caller degrades rather than surfaces.
 */
export function buildThreadQuery(ids: readonly string[]): string {
  const inner = ids.map((id) => `id:${id}`).join(' or ');

  return `thread:"{${inner}}"`;
}

/**
 * Non-empty lines of a notmuch listing.
 */
function toLines(raw: string): string[] {
  return raw.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

/* --------
 * Implementation
 * -------- */

/**
 * The mirror folders holding the thread these `Message-Id`s belong to, for one account.
 *
 * This exists because a conversation is not confined to a folder while the tools that read it are.
 * The replies sent from the mailbox live in `Sent`, and the messages received live wherever they were
 * filed, so a thread rebuilt inside a single folder is a half conversation that reads like a whole
 * one. notmuch is the only component that already knows the whole shape, because it indexes the
 * mirror rather than a mailbox.
 *
 * Returns an empty array when notmuch answers nothing, and never throws for that: the caller has a
 * working folder-local path and a missing index must degrade it, not break it.
 */
export async function findThreadFolders(
  accountId: string,
  messageIds: readonly string[],
): Promise<string[]> {
  // ---- Query build
  const ids = [...new Set(messageIds.map(toNotmuchId).filter((id) => id.length > 0))].slice(0, MAX_CHAIN_IDS);

  if (ids.length === 0) {
    return [];
  }

  // ---- Files of the threads the chain belongs to
  try {
    const files = toLines(await runNotmuch(['search', '--output=files', '--', buildThreadQuery(ids)]));

    // ---- Result mapping
    const folders = new Set<string>();

    for (const file of files) {
      if (isTombstoneFile(file)) {
        continue;
      }

      const location = locateInMirror(file);

      if (location !== undefined && location.accountId === accountId) {
        folders.add(location.folder);
      }
    }

    return [...folders];
  } catch (cause) {
    logger.debug('thread folder lookup through notmuch failed', { accountId, cause });

    return [];
  }
}
