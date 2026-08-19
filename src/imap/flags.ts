import { withMailbox } from './connection.js';
import { resolveSpecialFolder } from './folders.js';

import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

/**
 * `\Deleted` is not on the list, and that is not an oversight: this server does not delete mail.
 * See `.claude/rules/security.md` §4.
 */
const ALLOWED_FLAGS = ['\\Seen', '\\Flagged', '\\Answered', '\\Draft'] as const;

type AllowedFlag = (typeof ALLOWED_FLAGS)[number];

/* --------
 * Helpers
 * -------- */

function assertAllowedFlags(flags: readonly string[]): AllowedFlag[] {
  const rejected = flags.filter((flag) => !ALLOWED_FLAGS.includes(flag as AllowedFlag));

  if (rejected.length > 0) {
    throw new MailbridgeError('imap_operation_failed', `Flags not allowed: ${rejected.join(', ')}.`, {
      remediation: `Allowed flags: ${ALLOWED_FLAGS.join(', ')}. \\Deleted is unsupported by design.`,
    });
  }

  return [...flags] as AllowedFlag[];
}

/* --------
 * Implementation
 * -------- */

/**
 * Adds or removes flags on a message. A reversible operation.
 */
export async function setFlags(
  account: Account,
  folder: string,
  uid: number,
  options: { add?: readonly string[]; remove?: readonly string[] },
): Promise<void> {
  // ---- Validation
  const add = options.add === undefined ? [] : assertAllowedFlags(options.add);
  const remove = options.remove === undefined ? [] : assertAllowedFlags(options.remove);

  if (add.length === 0 && remove.length === 0) {
    throw new MailbridgeError('imap_operation_failed', 'No flags to add or remove.', {
      remediation: 'Provide at least one flag in `add` or in `remove`.',
    });
  }

  await withMailbox(account, folder, async (client) => {
    if (add.length > 0) {
      await client.messageFlagsAdd(String(uid), add, { uid: true });
    }

    if (remove.length > 0) {
      await client.messageFlagsRemove(String(uid), remove, { uid: true });
    }
  });

  logger.info('flags updated', { accountId: account.id, folder, uid, add, remove });
}

/**
 * Moves a message to another folder. This is the only form of "removal" available, and it is
 * reversible: the message still exists, elsewhere.
 */
export async function moveMessage(
  account: Account,
  folder: string,
  uid: number,
  destination: string,
): Promise<{ destination: string; uid: number | undefined }> {
  if (destination === folder) {
    throw new MailbridgeError('imap_operation_failed', 'Source and destination are the same.', {
      remediation: 'Pick a different destination folder.',
    });
  }

  const result = await withMailbox(account, folder, async (client) => (
    client.messageMove(String(uid), destination, { uid: true })
  ));

  // ---- Result mapping
  if (result === false) {
    throw new MailbridgeError('imap_operation_failed', `The server refused to move message ${uid}.`, {
      remediation: `Check that folder "${destination}" exists with \`list_folders\`.`,
    });
  }

  const movedUid = result.uidMap === undefined ? undefined : result.uidMap.get(uid);

  logger.info('message moved', { accountId: account.id, from: folder, to: destination, uid, movedUid });

  return { destination, uid: movedUid };
}

/**
 * Moves to the account's archive folder, resolved automatically.
 */
export async function archiveMessage(
  account: Account,
  folder: string,
  uid: number,
): Promise<{ destination: string; uid: number | undefined }> {
  const destination = await resolveSpecialFolder(account, 'archive');

  return moveMessage(account, folder, uid, destination);
}
