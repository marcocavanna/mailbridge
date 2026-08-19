import { withImap } from './connection.js';
import { listFolders } from './folders.js';

import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';

/* --------
 * Types
 * -------- */

export interface FolderCounts {
  path: string;
  messages: number;
  unseen: number;
}

/* --------
 * Helpers
 * -------- */

/**
 * Delimiter the server uses for folder hierarchy, discovered from the folders it lists.
 *
 * It cannot be assumed: it is `/` on some servers, `.` on others, and building a nested path with the
 * wrong one produces a top-level folder with a dot in its name rather than a child.
 */
async function resolveDelimiter(account: Account): Promise<string> {
  const folders = await listFolders(account);

  return folders[0]?.delimiter ?? '/';
}

/* --------
 * Implementation
 * -------- */

/**
 * Message and unseen counts for a folder, without selecting it.
 */
export async function readFolderCounts(account: Account, path: string): Promise<FolderCounts> {
  return withImap(account, async (client) => {
    try {
      const status = await client.status(path, { messages: true, unseen: true });

      return {
        path,
        messages: status.messages ?? 0,
        unseen:   status.unseen ?? 0,
      };
    } catch (cause) {
      throw new MailbridgeError('folder_not_found', `Cannot read the status of "${path}".`, {
        remediation: 'Check the exact path with `list_folders`.',
        cause,
      });
    }
  });
}

/**
 * Creates a folder.
 *
 * Nested paths use the server's own delimiter: pass `Clients/Acme` and it is translated to whatever
 * separator this server expects.
 */
export async function createFolder(account: Account, path: string): Promise<{ path: string; created: boolean }> {
  const delimiter = await resolveDelimiter(account);
  const normalized = path.split(/[/.]/).filter((segment) => segment.length > 0).join(delimiter);

  if (normalized.length === 0) {
    throw new MailbridgeError('imap_operation_failed', 'Empty folder name.', {
      remediation: 'Provide a name, optionally nested as `Parent/Child`.',
    });
  }

  return withImap(account, async (client) => {
    try {
      const result = await client.mailboxCreate(normalized);

      logger.info('folder created', { accountId: account.id, path: result.path });

      return { path: result.path, created: result.created };
    } catch (cause) {
      throw new MailbridgeError('imap_operation_failed', `The server refused to create "${normalized}".`, {
        remediation: 'It may already exist, or the parent folder may not allow children.',
        cause,
      });
    }
  });
}

/**
 * Renames a folder, which on IMAP is also how a folder is moved to a different parent.
 *
 * The messages travel with it: renaming is not a copy, and nothing is lost.
 */
export async function renameFolder(
  account: Account,
  path: string,
  newPath: string,
): Promise<{ path: string; newPath: string }> {
  const delimiter = await resolveDelimiter(account);
  const normalized = newPath.split(/[/.]/).filter((segment) => segment.length > 0).join(delimiter);

  if (normalized.length === 0) {
    throw new MailbridgeError('imap_operation_failed', 'Empty destination name.');
  }

  return withImap(account, async (client) => {
    try {
      const result = await client.mailboxRename(path, normalized);

      logger.info('folder renamed', { accountId: account.id, from: result.path, to: result.newPath });

      return { path: result.path, newPath: result.newPath };
    } catch (cause) {
      throw new MailbridgeError('imap_operation_failed', `Cannot rename "${path}" to "${normalized}".`, {
        remediation: 'Check that the source exists and the destination does not.',
        cause,
      });
    }
  });
}

/**
 * Deletes a folder, **only if it is empty**.
 *
 * On IMAP, deleting a folder destroys the messages inside it, and that would be the only operation in
 * this project capable of losing data. The count is checked first and a non-empty folder is refused
 * with the number of messages it holds, so the way forward is to move them somewhere else first.
 *
 * The check is not a guarantee against a race with another client, but it turns the common accident
 * into an error message.
 */
export async function deleteFolder(account: Account, path: string): Promise<{ path: string }> {
  // ---- Validation
  const counts = await readFolderCounts(account, path);

  if (counts.messages > 0) {
    throw new MailbridgeError('imap_operation_failed', `Folder "${path}" holds ${counts.messages} messages.`, {
      remediation: 'Only empty folders can be deleted: move the messages elsewhere first, then retry.',
    });
  }

  const folders = await listFolders(account);
  const children = folders.filter((folder) => folder.path !== path && folder.path.startsWith(`${path}${folder.delimiter}`));

  if (children.length > 0) {
    throw new MailbridgeError('imap_operation_failed', `Folder "${path}" has ${children.length} subfolders.`, {
      remediation: `Delete them first: ${children.map((folder) => folder.path).join(', ')}.`,
    });
  }

  const special = folders.find((folder) => folder.path === path)?.specialUse;

  if (special !== undefined) {
    throw new MailbridgeError('imap_operation_failed', `"${path}" is the ${special} folder.`, {
      remediation: 'Special folders are not deletable: the account needs them.',
    });
  }

  return withImap(account, async (client) => {
    try {
      const result = await client.mailboxDelete(path);

      logger.info('folder deleted', { accountId: account.id, path: result.path });

      return { path: result.path };
    } catch (cause) {
      throw new MailbridgeError('imap_operation_failed', `The server refused to delete "${path}".`, { cause });
    }
  });
}

/**
 * Subscribes or unsubscribes a folder. Subscription decides whether mail clients show it; it neither
 * creates nor deletes anything.
 */
export async function setFolderSubscription(
  account: Account,
  path: string,
  subscribed: boolean,
): Promise<{ path: string; subscribed: boolean }> {
  return withImap(account, async (client) => {
    const done = subscribed ? await client.mailboxSubscribe(path) : await client.mailboxUnsubscribe(path);

    if (!done) {
      throw new MailbridgeError('imap_operation_failed', `The server refused to change the subscription for "${path}".`);
    }

    logger.info('folder subscription changed', { accountId: account.id, path, subscribed });

    return { path, subscribed };
  });
}
