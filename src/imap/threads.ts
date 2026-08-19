import { withMailbox } from './connection.js';
import { getMessage } from './messages.js';

import { mapAddresses } from '#shared/address';

import type { Account } from '#config/accounts.schema';
import type { MessageSummary, Thread } from '#shared/mail.types';

/* --------
 * Constants
 * -------- */

const MAX_THREAD_MESSAGES = 50;

/* --------
 * Helpers
 * -------- */

function normalizeSubject(subject: string): string {
  return subject.replace(/^(?:\s*(?:re|r|fw|fwd|i)\s*:\s*)+/i, '').trim().toLowerCase();
}

/* --------
 * Implementation
 * -------- */

/**
 * Rebuilds the conversation a message belongs to, within its folder.
 *
 * The criterion is the set of `Message-Id`s in the chain — the message's own plus its `References` —
 * searched in the `References` and `In-Reply-To` headers of the other messages.
 *
 * Stated limitation: the search is **confined to the current folder**. A thread with half its
 * messages in `Sent` is not reassembled in full. Covering that would require the notmuch index,
 * which is not guaranteed to be available.
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

  const messages = await withMailbox(account, folder, async (client) => {
    // ---- Query: everything that references any id in the chain
    const uids = new Set<number>([uid]);

    for (const messageId of chain) {
      const byReferences = await client.search({ header: { references: messageId } }, { uid: true });
      const byReplyTo = await client.search({ header: { 'in-reply-to': messageId } }, { uid: true });
      const byId = await client.search({ header: { 'message-id': messageId } }, { uid: true });

      for (const found of [byReferences, byReplyTo, byId]) {
        if (found !== false) {
          for (const entry of found) {
            uids.add(entry);
          }
        }
      }
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

  // ---- Result mapping
  const relevant = messages.filter((entry) => (
    entry.uid === uid || normalizeSubject(entry.subject) === normalized || chain.has(entry.messageId ?? '')
  ));

  relevant.sort((left, right) => (left.date ?? '').localeCompare(right.date ?? ''));

  return {
    rootMessageId: relevant[0]?.messageId,
    subject:       anchor.subject,
    messages:      relevant,
  };
}
