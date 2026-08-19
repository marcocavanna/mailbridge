import { withMailbox } from './connection.js';
import { resolveSpecialFolder } from './folders.js';

import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account, SpecialFolder } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

/**
 * Upper bound on a single bulk operation.
 *
 * It is not a technical limit — IMAP would take far more — but a blast-radius limit: a mistaken or
 * injected instruction can reorganize at most this many messages before somebody notices. Everything
 * here is reversible, so the cost of hitting the cap is running the operation again.
 */
const MAX_BULK_MESSAGES = 500;

/** Flags a bulk operation may set. `\Deleted` is absent for the same reason it is absent everywhere. */
const ALLOWED_FLAGS = ['\\Seen', '\\Flagged', '\\Answered'] as const;

type AllowedFlag = (typeof ALLOWED_FLAGS)[number];

/* --------
 * Types
 * -------- */

export interface BulkMoveResult {
  destination: string;
  /** How many messages the operation was asked to move. */
  requested: number;
  /** How many the server confirmed. */
  moved: number;
  /** New uids in the destination, when the server reports them (UIDPLUS). */
  movedUids: number[];
}

export interface BulkFlagResult {
  requested: number;
  added: readonly string[];
  removed: readonly string[];
}

/* --------
 * Helpers
 * -------- */

/**
 * Validates and normalizes a uid set.
 *
 * Duplicates are removed because a repeated uid in the range would make the server's count disagree
 * with the caller's, and that difference is the only signal available to tell a partial move from a
 * complete one.
 *
 * Exported because the cap is a safety rule rather than an implementation detail: it is worth testing
 * on its own.
 */
export function validateUidSet(uids: readonly number[]): number[] {
  const unique = [...new Set(uids)].filter((uid) => Number.isInteger(uid) && uid > 0);

  if (unique.length === 0) {
    throw new MailbridgeError('imap_operation_failed', 'No valid message given.', {
      remediation: 'Pass at least one uid, as returned by search or list.',
    });
  }

  if (unique.length > MAX_BULK_MESSAGES) {
    throw new MailbridgeError('imap_operation_failed', `Too many messages in one operation: ${unique.length}.`, {
      remediation: `The limit is ${MAX_BULK_MESSAGES} at a time. Split the work and repeat — it is safe to run again.`,
    });
  }

  return unique.sort((left, right) => left - right);
}

function assertAllowedFlags(flags: readonly string[]): AllowedFlag[] {
  const rejected = flags.filter((flag) => !ALLOWED_FLAGS.includes(flag as AllowedFlag));

  if (rejected.length > 0) {
    throw new MailbridgeError('imap_operation_failed', `Flags not allowed: ${rejected.join(', ')}.`, {
      remediation: `Allowed flags: ${ALLOWED_FLAGS.join(', ')}.`,
    });
  }

  return [...flags] as AllowedFlag[];
}

/* --------
 * Implementation
 * -------- */

/**
 * Moves a set of messages in a **single** IMAP operation.
 *
 * Doing it one message at a time would be wrong twice over: it costs one round trip per message, and
 * uids shift as messages leave the folder, so a loop built on a stale list starts moving the wrong
 * mail. Handing the whole set to the server avoids both.
 *
 * `moved` can be lower than `requested` without an error: a message may have been moved or expunged by
 * another client in the meantime. The difference is reported rather than hidden.
 */
export async function moveMessages(
  account: Account,
  folder: string,
  uids: readonly number[],
  destination: string,
): Promise<BulkMoveResult> {
  // ---- Validation
  const targets = validateUidSet(uids);

  if (destination === folder) {
    throw new MailbridgeError('imap_operation_failed', 'Source and destination are the same folder.');
  }

  const result = await withMailbox(account, folder, async (client) => (
    client.messageMove(targets, destination, { uid: true })
  ));

  // ---- Result mapping
  if (result === false) {
    throw new MailbridgeError('imap_operation_failed', `The server refused to move ${targets.length} messages.`, {
      remediation: `Check that folder "${destination}" exists with \`list_folders\`.`,
    });
  }

  const movedUids = result.uidMap === undefined ? [] : [...result.uidMap.values()];
  const moved = result.uidMap === undefined ? targets.length : result.uidMap.size;

  logger.info('messages moved in bulk', {
    accountId: account.id,
    from:      folder,
    to:        destination,
    requested: targets.length,
    moved,
  });

  return { destination, requested: targets.length, moved, movedUids };
}

/**
 * Moves a set of messages into one of the account's special folders, resolved automatically.
 *
 * This is how archiving and trashing are expressed: both are moves, and both are reversible.
 */
export async function moveMessagesToSpecial(
  account: Account,
  folder: string,
  uids: readonly number[],
  special: SpecialFolder,
): Promise<BulkMoveResult> {
  const destination = await resolveSpecialFolder(account, special);

  return moveMessages(account, folder, uids, destination);
}

/**
 * Adds or removes flags on a set of messages, in a single operation.
 */
export async function flagMessages(
  account: Account,
  folder: string,
  uids: readonly number[],
  options: { add?: readonly string[]; remove?: readonly string[] },
): Promise<BulkFlagResult> {
  // ---- Validation
  const targets = validateUidSet(uids);
  const add = options.add === undefined ? [] : assertAllowedFlags(options.add);
  const remove = options.remove === undefined ? [] : assertAllowedFlags(options.remove);

  if (add.length === 0 && remove.length === 0) {
    throw new MailbridgeError('imap_operation_failed', 'No flags to add or remove.', {
      remediation: 'Provide at least one flag in `add` or in `remove`.',
    });
  }

  await withMailbox(account, folder, async (client) => {
    if (add.length > 0) {
      await client.messageFlagsAdd(targets, add, { uid: true });
    }

    if (remove.length > 0) {
      await client.messageFlagsRemove(targets, remove, { uid: true });
    }
  });

  logger.info('flags updated in bulk', { accountId: account.id, folder, requested: targets.length, add, remove });

  return { requested: targets.length, added: add, removed: remove };
}

/**
 * The cap on a single bulk operation, so callers can explain it before hitting it.
 */
export function getBulkLimit(): number {
  return MAX_BULK_MESSAGES;
}
