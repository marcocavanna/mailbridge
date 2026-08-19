import { ImapFlow } from 'imapflow';

import { getImapPassword } from '#secrets/keychain';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const CONNECT_TIMEOUT_MS = 20_000;

const GREETING_TIMEOUT_MS = 15_000;

const SOCKET_TIMEOUT_MS = 60_000;

/* --------
 * Internal state
 * -------- */

/**
 * One connection per account, reused. No module opens a connection on its own: everything goes
 * through `withImap`.
 */
const clients = new Map<string, ImapFlow>();

/* --------
 * Helpers
 * -------- */

async function connect(account: Account): Promise<ImapFlow> {
  // ---- Credentials
  const password = await getImapPassword(account);

  // ---- Connection setup
  const client = new ImapFlow({
    host:   account.imap.host,
    port:   account.imap.port,
    secure: account.imap.secure,
    auth:   {
      user: account.imap.user,
      pass: password,
    },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout:   GREETING_TIMEOUT_MS,
    socketTimeout:     SOCKET_TIMEOUT_MS,
    /**
     * imapflow logs IMAP traffic, message bodies included. It stays off: see
     * `.claude/rules/security.md`.
     */
    logger: false,
  });

  client.on('error', (error: unknown) => {
    logger.warn('IMAP connection error', { accountId: account.id, error });
  });

  try {
    await client.connect();
  } catch (cause) {
    throw new MailbridgeError('imap_connection_failed', `IMAP connection to ${account.imap.host} failed.`, {
      remediation: 'Check host, port, and that the Keychain credential is still valid.',
      cause,
    });
  }

  logger.info('IMAP connection established', { accountId: account.id, host: account.imap.host });

  return client;
}

/* --------
 * Implementation
 * -------- */

/**
 * Returns a usable connection for the account, reconnecting a dropped one.
 */
export async function getConnection(account: Account): Promise<ImapFlow> {
  const existing = clients.get(account.id);

  if (existing !== undefined && existing.usable) {
    return existing;
  }

  if (existing !== undefined) {
    clients.delete(account.id);
    logger.debug('IMAP connection no longer usable, reconnecting', { accountId: account.id });
  }

  const client = await connect(account);

  clients.set(account.id, client);

  return client;
}

/**
 * Runs an operation holding the lock on a folder, always releasing it.
 *
 * The lock is imapflow's: it serializes operations on the same connection, which is exactly what a
 * shared per-account connection needs.
 */
export async function withMailbox<T>(
  account: Account,
  folder: string,
  operation: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = await getConnection(account);

  let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;

  try {
    lock = await client.getMailboxLock(folder);
  } catch (cause) {
    throw new MailbridgeError('folder_not_found', `Cannot open folder "${folder}" on "${account.id}".`, {
      remediation: 'Use `list_folders` to see the exact paths available.',
      cause,
    });
  }

  try {
    return await operation(client);
  } finally {
    lock.release();
  }
}

/**
 * Runs an operation that needs no selected folder (LIST, STATUS, …).
 */
export async function withImap<T>(account: Account, operation: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await getConnection(account);

  return operation(client);
}

/**
 * Closes every connection. Called on server shutdown.
 */
export async function closeAllConnections(): Promise<void> {
  const entries = [...clients.entries()];

  clients.clear();

  await Promise.allSettled(entries.map(async ([, client]) => client.logout()));

  logger.info('IMAP connections closed', { count: entries.length });
}
