import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { accountsConfigSchema } from './accounts.schema.js';
import { resolveConfigPath } from './load-accounts.js';

import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account, AccountsConfig } from './accounts.schema.js';

/* --------
 * Constants
 * -------- */

const EMPTY_CONFIG: AccountsConfig = { version: 1, accounts: [] };

/** The configuration holds hosts and usernames: readable by the owner only. */
const FILE_MODE = 0o600;

/* --------
 * Helpers
 * -------- */

/**
 * Reads the configuration tolerating a missing file, which is the normal state before the first
 * account. Unlike `loadAccountsConfig` it does not throw: the write flows need it.
 */
export async function readConfigOrEmpty(): Promise<AccountsConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolveConfigPath(), 'utf8'));
    const result = accountsConfigSchema.safeParse(parsed);

    if (!result.success) {
      throw new MailbridgeError('config_invalid', 'The existing configuration does not match the schema.', {
        remediation: 'Fix it by hand, or move it aside before adding accounts.',
      });
    }

    return result.data;
  } catch (cause) {
    if (cause instanceof MailbridgeError) {
      throw cause;
    }

    return EMPTY_CONFIG;
  }
}

/**
 * Writes the configuration atomically: temporary file plus `rename`.
 *
 * An interruption halfway through a write would leave a truncated configuration, which on the next
 * start would look corrupted without ever having been.
 */
async function writeConfigAtomic(config: AccountsConfig): Promise<string> {
  const path = resolveConfigPath();
  const temporary = `${path}.tmp`;

  // ---- Validation before touching the disk
  const result = accountsConfigSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

    throw new MailbridgeError('config_invalid', `Invalid configuration: ${issues}.`);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(result.data, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
  await rename(temporary, path);

  return path;
}

/* --------
 * Implementation
 * -------- */

/**
 * Adds an account. Rejects an id that already exists: overwriting is a different operation and goes
 * through `updateAccount`.
 */
export async function addAccount(account: Account): Promise<string> {
  const config = await readConfigOrEmpty();

  if (config.accounts.some((entry) => entry.id === account.id)) {
    throw new MailbridgeError('config_invalid', `Account "${account.id}" already exists.`, {
      remediation: 'Edit it instead, or pick a different id.',
    });
  }

  const path = await writeConfigAtomic({ version: 1, accounts: [...config.accounts, account] });

  logger.info('account added', { accountId: account.id });

  return path;
}

/**
 * Replaces an existing account, keeping its position in the list.
 */
export async function updateAccount(accountId: string, account: Account): Promise<string> {
  const config = await readConfigOrEmpty();
  const index = config.accounts.findIndex((entry) => entry.id === accountId);

  if (index === -1) {
    throw new MailbridgeError('account_not_found', `No account with id "${accountId}".`);
  }

  if (account.id !== accountId && config.accounts.some((entry) => entry.id === account.id)) {
    throw new MailbridgeError('config_invalid', `Cannot rename to "${account.id}": the id is already in use.`);
  }

  const accounts = [...config.accounts];

  accounts[index] = account;

  const path = await writeConfigAtomic({ version: 1, accounts });

  logger.info('account updated', { accountId, newId: account.id });

  return path;
}

/**
 * Removes an account from the configuration.
 *
 * It touches **only** the configuration: the Keychain item and the on-disk mirror have lives of
 * their own and are removed by explicit, separate actions. See `.claude/rules/security.md` §4.
 */
export async function removeAccount(accountId: string): Promise<{ path: string; removed: Account }> {
  const config = await readConfigOrEmpty();
  const removed = config.accounts.find((entry) => entry.id === accountId);

  if (removed === undefined) {
    throw new MailbridgeError('account_not_found', `No account with id "${accountId}".`);
  }

  const accounts = config.accounts.filter((entry) => entry.id !== accountId);
  const path = await writeConfigAtomic({ version: 1, accounts });

  logger.info('account removed from the configuration', { accountId });

  return { path, removed };
}
