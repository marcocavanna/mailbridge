import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import { accountsConfigSchema } from './accounts.schema.js';

import type { Account, AccountsConfig } from './accounts.schema.js';

/* --------
 * Constants
 * -------- */

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'mailbridge');

/* --------
 * Helpers
 * -------- */

/**
 * Path of the configuration file. `MAILBRIDGE_CONFIG` takes precedence, for tests and for
 * alternative configurations.
 */
export function resolveConfigPath(): string {
  const override = process.env['MAILBRIDGE_CONFIG'];

  return override !== undefined && override.length > 0 ? override : join(DEFAULT_CONFIG_DIR, 'accounts.json');
}

/* --------
 * Implementation
 * -------- */

/**
 * Loads and validates the account configuration. It holds no credentials: those live in the
 * Keychain, see `#secrets/keychain`.
 */
export async function loadAccountsConfig(): Promise<AccountsConfig> {
  // ---- Read
  const path = resolveConfigPath();
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    throw new MailbridgeError('config_missing', `No account configuration found at ${path}.`, {
      remediation: 'Run `mailbridge account add` to register your first account.',
      cause,
    });
  }

  // ---- Parse
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new MailbridgeError('config_invalid', `${path} is not valid JSON.`, {
      remediation: 'Fix the syntax and try again.',
      cause,
    });
  }

  // ---- Validation
  const result = accountsConfigSchema.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    throw new MailbridgeError('config_invalid', `${path} does not match the schema: ${issues}.`, {
      remediation: 'Compare the file with accounts.example.json.',
    });
  }

  // ---- Duplicate ids
  const seen = new Set<string>();

  for (const account of result.data.accounts) {
    if (seen.has(account.id)) {
      throw new MailbridgeError('config_invalid', `Account id "${account.id}" is duplicated.`, {
        remediation: 'Every account needs a unique id: rename one of them.',
      });
    }

    seen.add(account.id);
  }

  // ---- Empty is valid on disk, but useless to a caller that wants to reach a mailbox
  if (result.data.accounts.length === 0) {
    throw new MailbridgeError('config_missing', `No accounts configured in ${path}.`, {
      remediation: 'Add one with `mailbridge account add`.',
    });
  }

  logger.debug('configuration loaded', { path, accounts: result.data.accounts.length });

  return result.data;
}

/**
 * Resolves an account by id, with an error that lists the valid alternatives.
 */
export function findAccount(config: AccountsConfig, accountId: string): Account {
  const account = config.accounts.find((candidate) => candidate.id === accountId);

  if (account === undefined) {
    const available = config.accounts.map((candidate) => candidate.id).join(', ');

    throw new MailbridgeError('account_not_found', `No account with id "${accountId}".`, {
      remediation: `Available accounts: ${available}.`,
    });
  }

  return account;
}
