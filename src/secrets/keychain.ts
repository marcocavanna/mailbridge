import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MailbridgeError } from '#shared/errors';
import { logger, registerSecret } from '#shared/logger';

import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const SECURITY_BIN = '/usr/bin/security';

const SERVICE_PREFIX = 'mailbridge';

/** Credentials are small: a tight buffer avoids holding on to unexpected output. */
const MAX_OUTPUT_BYTES = 4096;

const execFileAsync = promisify(execFile);

/* --------
 * Types
 * -------- */

/**
 * `oauth` holds a refresh token, never a password: see `.claude/rules/security.md` §1.
 */
export type CredentialKind = 'imap' | 'smtp' | 'oauth';

/* --------
 * Helpers
 * -------- */

/**
 * Service name of the Keychain item. `smtp` gets a separate item only when needed: when it is
 * missing we fall back to the IMAP one, which is the normal case. `oauth` is its own item, so an
 * account moved to OAuth never overwrites the password it used before.
 */
export function buildServiceName(accountId: string, kind: CredentialKind): string {
  return kind === 'imap' ? `${SERVICE_PREFIX}:${accountId}` : `${SERVICE_PREFIX}:${accountId}:${kind}`;
}

/* --------
 * Implementation
 * -------- */

/**
 * Reads a password from the Keychain. The value is registered as a secret before being returned, so
 * no later log can reveal it — see `.claude/rules/security.md` §1.
 *
 * `execFile` without a shell: `accountId` and `user` are never interpolated into a command line.
 */
async function readKeychainItem(service: string, user: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      SECURITY_BIN,
      ['find-generic-password', '-s', service, '-a', user, '-w'],
      { maxBuffer: MAX_OUTPUT_BYTES },
    );

    const password = stdout.replace(/\n$/, '');

    if (password.length === 0) {
      return undefined;
    }

    registerSecret(password);

    return password;
  } catch {
    // `security` exits non-zero simply when the item is absent: that is not an error condition.
    return undefined;
  }
}

/**
 * IMAP credential for an account.
 */
export async function getImapPassword(account: Account): Promise<string> {
  const service = buildServiceName(account.id, 'imap');
  const password = await readKeychainItem(service, account.imap.user);

  if (password === undefined) {
    throw new MailbridgeError('credential_missing', `No IMAP credential in the Keychain for "${account.id}".`, {
      remediation: missingCredentialRemediation(account),
    });
  }

  logger.debug('IMAP credential read from the Keychain', { accountId: account.id, service });

  return password;
}

/**
 * SMTP credential. Falls back to the IMAP one when no dedicated item exists: most providers use the
 * same password for both.
 */
export async function getSmtpPassword(account: Account): Promise<string> {
  const user = account.smtp?.user ?? account.imap.user;
  const dedicated = await readKeychainItem(buildServiceName(account.id, 'smtp'), user);

  if (dedicated !== undefined) {
    logger.debug('dedicated SMTP credential read from the Keychain', { accountId: account.id });

    return dedicated;
  }

  return getImapPassword(account);
}

/**
 * The stored OAuth refresh token, or `undefined` when the account has never signed in.
 */
export async function readRefreshToken(account: Account): Promise<string | undefined> {
  return readKeychainItem(buildServiceName(account.id, 'oauth'), account.imap.user);
}

/**
 * Checks that the items exist without returning their content. This is the only diagnostic allowed
 * on credentials. Which item depends on how the account authenticates.
 */
export async function hasCredentials(account: Account): Promise<boolean> {
  const kind: CredentialKind = account.auth.type === 'oauth2' ? 'oauth' : 'imap';
  const value = await readKeychainItem(buildServiceName(account.id, kind), account.imap.user);

  return value !== undefined;
}

/**
 * The remediation for a missing credential, by kind of account. Shared so every path that finds the
 * credential missing names the same command.
 */
export function missingCredentialRemediation(account: Account): string {
  return account.auth.type === 'oauth2'
    ? `Run \`mailbridge account login ${account.id}\` to sign in.`
    : `Run \`mailbridge account edit ${account.id}\` and set the password.`;
}
