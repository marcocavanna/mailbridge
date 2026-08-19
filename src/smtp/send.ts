import { createTransport } from 'nodemailer';

import { withMailbox } from '#imap/connection';
import { setFlags, moveMessage } from '#imap/flags';
import { resolveSpecialFolder } from '#imap/folders';
import { getMessage } from '#imap/messages';
import { getSmtpPassword } from '#secrets/keychain';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';
import type { Transporter } from 'nodemailer';

/* --------
 * Constants
 * -------- */

const SMTP_TIMEOUT_MS = 30_000;

/* --------
 * Types
 * -------- */

export interface SendResult {
  accountId: string;
  messageId: string | undefined;
  recipients: string[];
  /** Where the sent message ended up. */
  sentFolder: string;
  sentUid: number | undefined;
}

/* --------
 * Internal state
 * -------- */

const transporters = new Map<string, Transporter>();

/* --------
 * Helpers
 * -------- */

async function getTransporter(account: Account): Promise<Transporter> {
  const existing = transporters.get(account.id);

  if (existing !== undefined) {
    return existing;
  }

  // ---- Connection setup
  const password = await getSmtpPassword(account);

  const transporter = createTransport({
    host:   account.smtp.host,
    port:   account.smtp.port,
    secure: account.smtp.secure,
    /** STARTTLS is mandatory on 587: never send in plaintext. See `security.md` §6. */
    requireTLS:      !account.smtp.secure,
    auth:            {
      user: account.smtp.user ?? account.imap.user,
      pass: password,
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout:   SMTP_TIMEOUT_MS,
    socketTimeout:     SMTP_TIMEOUT_MS,
  });

  transporters.set(account.id, transporter);

  return transporter;
}

/* --------
 * Implementation
 * -------- */

/**
 * Sends a draft already saved on the server, then moves it to `Sent`.
 *
 * It takes a reference to a draft, not a body: that is the structural guarantee that nothing goes out
 * without first having been written somewhere the user can read it. See `security.md` §3.
 */
export async function sendDraft(account: Account, draftUid: number): Promise<SendResult> {
  // ---- Load draft
  const draftsFolder = await resolveSpecialFolder(account, 'drafts');
  const draft = await getMessage(account, draftsFolder, draftUid);

  const recipients = [...draft.to, ...draft.cc].map((entry) => entry.address);

  if (recipients.length === 0) {
    throw new MailbridgeError('send_rejected', `Draft ${draftUid} has no recipients.`, {
      remediation: 'Rewrite the draft with at least one recipient.',
    });
  }

  const source = await withMailbox(account, draftsFolder, async (client) => {
    const entry = await client.fetchOne(String(draftUid), { uid: true, source: true }, { uid: true });

    return entry === false ? undefined : entry.source;
  });

  if (source === undefined) {
    throw new MailbridgeError('send_rejected', `Draft ${draftUid} is no longer readable in "${draftsFolder}".`, {
      remediation: 'Recreate the draft and try again.',
    });
  }

  // ---- Send
  const transporter = await getTransporter(account);

  let messageId: string | undefined;

  try {
    const info = await transporter.sendMail({
      envelope: {
        from: account.address,
        to:   recipients,
      },
      raw: source,
    });

    messageId = info.messageId;
  } catch (cause) {
    throw new MailbridgeError('smtp_send_failed', `Sending through ${account.smtp.host} failed.`, {
      remediation: 'The draft is untouched on the server: fix the problem and try sending it again.',
      cause,
    });
  }

  logger.info('message sent', { accountId: account.id, recipients: recipients.length, messageId });

  // ---- Move to Sent
  const sentFolder = await resolveSpecialFolder(account, 'sent');
  const moved = await moveMessage(account, draftsFolder, draftUid, sentFolder);

  if (moved.uid !== undefined) {
    await setFlags(account, sentFolder, moved.uid, { remove: ['\\Draft'] });
  }

  return {
    accountId:  account.id,
    messageId,
    recipients,
    sentFolder,
    sentUid:    moved.uid,
  };
}

/**
 * Closes the SMTP transports. Called on shutdown.
 */
export function closeAllTransporters(): void {
  for (const transporter of transporters.values()) {
    transporter.close();
  }

  transporters.clear();
}
