import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import { withMailbox } from '#imap/connection';
import { resolveSpecialFolder } from '#imap/folders';
import { getMessage } from '#imap/messages';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';
import type { MailAddress } from '#shared/mail.types';

/* --------
 * Types
 * -------- */

export interface Composition {
  to: readonly string[];
  cc?: readonly string[] | undefined;
  subject: string;
  /** Plain text only. Outgoing HTML is not supported: see the note on `buildMime`. */
  text: string;
  inReplyTo?: string | undefined;
  references?: readonly string[] | undefined;
}

export interface DraftRef {
  accountId: string;
  folder: string;
  uid: number;
  subject: string;
  to: readonly string[];
}

/* --------
 * Helpers
 * -------- */

function formatSender(account: Account): string {
  return `"${account.label.replace(/"/g, '')}" <${account.address}>`;
}

function formatReplySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function formatAddressList(addresses: readonly MailAddress[]): string[] {
  return addresses.map((entry) => entry.address);
}

/**
 * Builds the draft's MIME. `Bcc` is unsupported on purpose: in a draft it lives as a header, and a
 * send that forgets to strip it reveals the hidden recipients to everyone. The day it is needed, it
 * has to be implemented by moving it into the SMTP envelope — not by adding a field.
 */
async function buildMime(account: Account, composition: Composition): Promise<Buffer> {
  const composer = new MailComposer({
    from:    formatSender(account),
    to:      [...composition.to],
    cc:      composition.cc === undefined ? undefined : [...composition.cc],
    subject: composition.subject,
    text:    composition.text,
    inReplyTo: composition.inReplyTo,
    references: composition.references === undefined ? undefined : [...composition.references],
  });

  return composer.compile().build();
}

/* --------
 * Implementation
 * -------- */

/**
 * Saves a draft in the account's `Drafts` folder and returns a reference to it.
 *
 * This is the only entrance to sending: `sendDraft` only sends what is already written here, so what
 * goes out is exactly what the user has had the chance to read.
 */
export async function saveDraft(account: Account, composition: Composition): Promise<DraftRef> {
  // ---- Validation
  if (composition.to.length === 0) {
    throw new MailbridgeError('smtp_send_failed', 'No recipients.', {
      remediation: 'Provide at least one address in `to`.',
    });
  }

  // ---- Build
  const folder = await resolveSpecialFolder(account, 'drafts');
  const mime = await buildMime(account, composition);

  // ---- Append
  const result = await withMailbox(account, folder, async (client) => (
    client.append(folder, mime, ['\\Draft', '\\Seen'], new Date())
  ));

  if (result === false || result.uid === undefined) {
    throw new MailbridgeError('smtp_send_failed', `The server did not accept the draft in "${folder}".`, {
      remediation: 'Check the drafts folder path in accounts.json, under folders.drafts.',
    });
  }

  logger.info('draft saved', { accountId: account.id, folder, uid: result.uid });

  return {
    accountId: account.id,
    folder,
    uid:       result.uid,
    subject:   composition.subject,
    to:        composition.to,
  };
}

/**
 * Prepares a reply draft to a message, with the right subject and threading headers.
 */
export async function saveReplyDraft(
  account: Account,
  folder: string,
  uid: number,
  text: string,
  options: { replyAll: boolean } = { replyAll: false },
): Promise<DraftRef> {
  // ---- Load original
  const original = await getMessage(account, folder, uid);

  const primary = original.replyTo.length > 0 ? original.replyTo : original.from;

  if (primary.length === 0) {
    throw new MailbridgeError('smtp_send_failed', `Message ${uid} has no sender to reply to.`);
  }

  // ---- Recipients
  const own = account.address.toLowerCase();
  const cc = options.replyAll
    ? [...original.to, ...original.cc].filter((entry) => entry.address.toLowerCase() !== own)
    : [];

  const references = original.messageId === undefined
    ? original.references
    : [...original.references, original.messageId];

  return saveDraft(account, {
    to:         formatAddressList(primary),
    cc:         formatAddressList(cc),
    subject:    formatReplySubject(original.subject),
    text,
    inReplyTo:  original.messageId,
    references,
  });
}
