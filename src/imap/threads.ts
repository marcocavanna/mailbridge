import { withMailbox } from './connection.js';
import { listFolders } from './folders.js';
import { getMessage } from './messages.js';

import { resolveMirrorFolder } from '#mirror/paths';
import { findThreadFolders } from '#search/notmuch-threads';
import { mapAddresses } from '#shared/address';

import type { Account } from '#config/accounts.schema';
import type { MessageSummary, Thread } from '#shared/mail.types';

/* --------
 * Constants
 * -------- */

const MAX_THREAD_MESSAGES = 50;

/**
 * How many folders one conversation is looked for in. Two or three is the normal shape (where it was
 * filed, plus `Sent`); a higher number means the chain has been dragged through half the mailbox and
 * the cost of opening every one of them stops being worth it.
 */
const MAX_THREAD_FOLDERS = 8;

/**
 * How many header conditions travel in one `SEARCH`.
 *
 * The chain of a long conversation easily reaches fifteen ids, and each one is looked for in three
 * headers: issued one at a time that is forty-five round trips per folder, which is what made
 * rebuilding a thread take minutes. Batched into a single disjunction it is two. The cap keeps the
 * command well inside the line length a server will accept.
 */
const MAX_SEARCH_CONDITIONS = 30;

/* --------
 * Helpers
 * -------- */

function normalizeSubject(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|r|fw|fwd|i)\s*:\s*)+/i, '').trim().toLowerCase();
}

/**
 * Translates mirror folder paths back into the IMAP paths needed to open a mailbox.
 *
 * The direction matters: notmuch answers with the geometry of the maildir (`Archive/Suppliers`) and
 * IMAP wants the server's (`INBOX.Archive.Suppliers`). Rather than invert the delimiter rule by hand,
 * every folder the account announces is resolved forwards and the matches are kept, so the mapping
 * cannot disagree with the one the search uses.
 */
async function toImapFolders(account: Account, mirrorFolders: readonly string[]): Promise<string[]> {
  if (mirrorFolders.length === 0) {
    return [];
  }

  const wanted = new Set(mirrorFolders);
  const matched: string[] = [];

  for (const folder of await listFolders(account)) {
    const resolved = await resolveMirrorFolder(account, folder.path);

    if (resolved !== undefined && wanted.has(resolved)) {
      matched.push(folder.path);
    }
  }

  return matched;
}

/**
 * Every uid in one folder whose message references any id in the chain.
 */
async function collectFromFolder(
  account: Account,
  folder: string,
  chain: ReadonlySet<string>,
  seed: readonly number[],
): Promise<MessageSummary[]> {
  return withMailbox(account, folder, async (client) => {
    // ---- Query build
    const uids = new Set<number>(seed);

    const conditions = [...chain].flatMap((messageId) => [
      { header: { references: messageId } },
      { header: { 'in-reply-to': messageId } },
      { header: { 'message-id': messageId } },
    ]);

    for (let index = 0; index < conditions.length; index += MAX_SEARCH_CONDITIONS) {
      const batch = conditions.slice(index, index + MAX_SEARCH_CONDITIONS);
      const found = await client.search(batch.length === 1 ? batch[0] ?? {} : { or: batch }, { uid: true });

      if (found !== false) {
        for (const entry of found) {
          uids.add(entry);
        }
      }
    }

    if (uids.size === 0) {
      return [];
    }

    // ---- Fetch
    const collected: MessageSummary[] = [];
    const selected = [...uids].sort((left, right) => left - right).slice(0, MAX_THREAD_MESSAGES);

    for await (const entry of client.fetch(
      selected.join(','),
      {
        uid:           true,
        envelope:      true,
        flags:         true,
        size:          true,
        bodyStructure: true,
      },
      { uid: true },
    )) {
      const flags = entry.flags === undefined ? [] : [...entry.flags];

      collected.push({
        accountId:      account.id,
        folder,
        uid:            entry.uid,
        messageId:      entry.envelope?.messageId,
        subject:        entry.envelope?.subject ?? '(no subject)',
        from:           mapAddresses(entry.envelope?.from),
        to:             mapAddresses(entry.envelope?.to),
        cc:             mapAddresses(entry.envelope?.cc),
        date:           entry.envelope?.date === undefined ? undefined : entry.envelope.date.toISOString(),
        size:           entry.size ?? 0,
        flags,
        isSeen:         flags.includes('\\Seen'),
        isFlagged:      flags.includes('\\Flagged'),
        isAnswered:     flags.includes('\\Answered'),
        hasAttachments: entry.bodyStructure?.childNodes?.some((child) => child.disposition === 'attachment') === true,
        preview:        undefined,
      });
    }

    return collected;
  });
}

/* --------
 * Implementation
 * -------- */

/**
 * Rebuilds the conversation a message belongs to, across the folders that hold it.
 *
 * The criterion is the set of `Message-Id`s in the chain — the message's own plus its `References` —
 * searched in the `References` and `In-Reply-To` headers of the other messages.
 *
 * The folders to look in come from the notmuch index, which knows the whole shape of the thread
 * because it indexes the mirror rather than a mailbox. This is what puts the replies back next to the
 * messages they answer: without it a conversation whose outgoing half sits in `Sent` comes back as a
 * monologue by the other party, with nothing to signal that anything is missing.
 *
 * Degradation is deliberate: with no index, or an index that answers nothing, the search stays inside
 * the anchor's folder and `searchedFolders` says so, so the caller can report a partial view as
 * partial.
 */
export async function getThread(account: Account, folder: string, uid: number): Promise<Thread> {
  // ---- Load the anchor
  const anchor = await getMessage(account, folder, uid);

  const chain = new Set<string>(anchor.references);

  if (anchor.messageId !== undefined) {
    chain.add(anchor.messageId);
  }

  if (anchor.inReplyTo !== undefined) {
    chain.add(anchor.inReplyTo);
  }

  const normalized = normalizeSubject(anchor.subject);

  // ---- Folders in scope
  const fromIndex = await toImapFolders(account, await findThreadFolders(account.id, [...chain]));
  const scope = [folder, ...fromIndex.filter((entry) => entry !== folder)].slice(0, MAX_THREAD_FOLDERS);

  // ---- Collect
  const collected: MessageSummary[] = [];

  for (const target of scope) {
    const seed = target === folder ? [uid] : [];

    collected.push(...await collectFromFolder(account, target, chain, seed));
  }

  // ---- Result mapping
  const relevant = collected.filter((entry) => (
    (entry.folder === folder && entry.uid === uid)
      || normalizeSubject(entry.subject) === normalized
      || chain.has(entry.messageId ?? '')
  ));

  const deduped = new Map<string, MessageSummary>();

  for (const entry of relevant) {
    const key = entry.messageId ?? `${entry.folder}:${String(entry.uid)}`;

    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }

  const messages = [...deduped.values()].sort((left, right) => (left.date ?? '').localeCompare(right.date ?? ''));

  // ---- Return
  return {
    rootMessageId:   messages[0]?.messageId,
    subject:         anchor.subject,
    messages:        messages.slice(0, MAX_THREAD_MESSAGES),
    searchedFolders: scope,
  };
}
