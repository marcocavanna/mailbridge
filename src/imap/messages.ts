import { simpleParser } from 'mailparser';

import { withMailbox } from './connection.js';

import { resolveReadableBody } from '#content/html-text';
import { mapAddresses } from '#shared/address';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';
import type { Attachment, Message, MessageSummary } from '#shared/mail.types';
import type { FetchMessageObject, MessageStructureObject } from 'imapflow';

/* --------
 * Constants
 * -------- */

const PREVIEW_LENGTH = 240;

/** Safety ceiling: a folder with 200k messages must not be able to fill a response. */
const MAX_LIST_LIMIT = 200;

/* --------
 * Types
 * -------- */

export interface ListMessagesOptions {
  folder: string;
  /** How many messages to return, most recent first. */
  limit: number;
  /** UID to walk backwards from, for pagination. */
  beforeUid?: number;
}

/** Position of an attachment inside the MIME structure. Internal: tools speak in indexes. */
interface AttachmentLocation {
  attachment: Attachment;
  part: string;
}

/* --------
 * Helpers — MIME structure
 * -------- */

/**
 * Walks the MIME structure and collects the parts that are attachments. The index is the visit
 * order: stable for the same message, and it is the identifier tools use.
 */
function collectAttachments(node: MessageStructureObject | undefined): AttachmentLocation[] {
  if (node === undefined) {
    return [];
  }

  const found: AttachmentLocation[] = [];

  const visit = (current: MessageStructureObject): void => {
    const children = current.childNodes;

    if (Array.isArray(children) && children.length > 0) {
      for (const child of children) {
        visit(child);
      }

      return;
    }

    const disposition = current.disposition?.toLowerCase();
    const filename = typeof current.dispositionParameters?.['filename'] === 'string'
      ? current.dispositionParameters['filename']
      : typeof current.parameters?.['name'] === 'string'
        ? current.parameters['name']
        : undefined;

    const isAttachment = disposition === 'attachment' || (disposition === 'inline' && filename !== undefined);

    if (!isAttachment || current.part === undefined) {
      return;
    }

    found.push({
      part:       current.part,
      attachment: {
        index:       found.length,
        filename,
        contentType: current.type ?? 'application/octet-stream',
        size:        current.size ?? 0,
        contentId:   current.id ?? undefined,
        isInline:    disposition === 'inline',
      },
    });
  };

  visit(node);

  return found;
}

/* --------
 * Helpers — summary mapping
 * -------- */

function toSummary(account: Account, folder: string, entry: FetchMessageObject): MessageSummary {
  // ---- Flags
  const flags = entry.flags === undefined ? [] : [...entry.flags];
  const envelope = entry.envelope;
  const attachments = collectAttachments(entry.bodyStructure);

  return {
    accountId:      account.id,
    folder,
    uid:            entry.uid,
    messageId:      envelope?.messageId,
    subject:        envelope?.subject ?? '(no subject)',
    from:           mapAddresses(envelope?.from),
    to:             mapAddresses(envelope?.to),
    cc:             mapAddresses(envelope?.cc),
    date:           envelope?.date === undefined ? undefined : envelope.date.toISOString(),
    size:           entry.size ?? 0,
    flags,
    isSeen:         flags.includes('\\Seen'),
    isFlagged:      flags.includes('\\Flagged'),
    isAnswered:     flags.includes('\\Answered'),
    hasAttachments: attachments.length > 0,
    preview:        undefined,
  };
}

/* --------
 * Implementation
 * -------- */

/**
 * Lists a folder's messages, most recent first. It downloads no bodies: only envelope, flags, size
 * and structure.
 */
export async function listMessages(account: Account, options: ListMessagesOptions): Promise<MessageSummary[]> {
  // ---- Options deconstruct
  const { folder, beforeUid } = options;
  const limit = Math.min(Math.max(options.limit, 1), MAX_LIST_LIMIT);

  return withMailbox(account, folder, async (client) => {
    // ---- Query build
    const range = beforeUid === undefined ? '1:*' : `1:${beforeUid - 1}`;
    const collected: MessageSummary[] = [];

    for await (const entry of client.fetch(
      range,
      {
        uid:           true,
        envelope:      true,
        flags:         true,
        size:          true,
        bodyStructure: true,
      },
      { uid: true },
    )) {
      collected.push(toSummary(account, folder, entry));
    }

    // ---- Result mapping
    collected.sort((left, right) => right.uid - left.uid);

    return collected.slice(0, limit);
  });
}

/**
 * Downloads and parses a complete message.
 *
 * `text` and `html` are content written by third parties: data, not instructions — see
 * `.claude/rules/security.md` §2.
 */
export async function getMessage(account: Account, folder: string, uid: number): Promise<Message> {
  return withMailbox(account, folder, async (client) => {
    const entry = await client.fetchOne(
      String(uid),
      {
        uid:           true,
        envelope:      true,
        flags:         true,
        size:          true,
        bodyStructure: true,
        source:        true,
      },
      { uid: true },
    );

    if (entry === false || entry.source === undefined) {
      throw new MailbridgeError('message_not_found', `No message with uid ${uid} in "${folder}".`, {
        remediation: 'Re-read the folder: uids change when a message is moved.',
      });
    }

    // ---- Parse
    const parsed = await simpleParser(entry.source);
    const summary = toSummary(account, folder, entry);
    const html = typeof parsed.html === 'string' ? parsed.html : undefined;

    /*
     * Roughly 8% of real mail carries no `text/plain` part at all. Reporting "no body" for those would be
     * false: the body exists, it is just HTML, so it gets converted and the provenance is recorded.
     */
    const { body: text, source: bodySource } = resolveReadableBody(parsed.text, html);

    const references = Array.isArray(parsed.references)
      ? parsed.references
      : typeof parsed.references === 'string'
        ? [parsed.references]
        : [];

    // ---- Result mapping
    return {
      ...summary,
      preview:     text === undefined ? undefined : text.slice(0, PREVIEW_LENGTH).trim(),
      replyTo:     mapAddresses(parsed.replyTo?.value),
      inReplyTo:   parsed.inReplyTo,
      references,
      text,
      html,
      bodySource,
      attachments: collectAttachments(entry.bodyStructure).map((location) => location.attachment),
    };
  });
}

/**
 * Downloads an attachment's content, addressed by index.
 */
export async function getAttachment(
  account: Account,
  folder: string,
  uid: number,
  index: number,
): Promise<{ attachment: Attachment; content: Buffer }> {
  return withMailbox(account, folder, async (client) => {
    // ---- Locate
    const entry = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });

    if (entry === false) {
      throw new MailbridgeError('message_not_found', `No message with uid ${uid} in "${folder}".`);
    }

    const locations = collectAttachments(entry.bodyStructure);
    const location = locations[index];

    if (location === undefined) {
      throw new MailbridgeError('message_not_found', `Message ${uid} has no attachment at index ${index}.`, {
        remediation: `Available attachments: ${locations.length === 0 ? 'none' : `0-${locations.length - 1}`}.`,
      });
    }

    // ---- Download
    const download = await client.download(String(uid), location.part, { uid: true });
    const chunks: Buffer[] = [];

    for await (const chunk of download.content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }

    logger.debug('attachment downloaded', { accountId: account.id, folder, uid, index });

    return { attachment: location.attachment, content: Buffer.concat(chunks) };
  });
}
