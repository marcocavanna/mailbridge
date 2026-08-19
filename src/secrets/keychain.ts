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

export type CredentialKind = 'imap' | 'smtp';

/* --------
 * Helpers
 * -------- */

/**
 * Service name of the Keychain item. `smtp` gets a separate item only when needed: when it is
 * missing we fall back to the IMAP one, which is the normal case.
 */
export function buildServiceName(accountId: string, kind: CredentialKind): string {
  return kind === 'imap' ? `${SERVICE_PREFIX}:${accountId}` : `${SERVICE_PREFIX}:${accountId}:smtp`;
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
async function readPassword(service: string, user: string): Promise<string | undefined> {
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
  const password = await readPassword(service, account.imap.user);

  if (password === undefined) {
    throw new MailbridgeError('credential_missing', `No IMAP credential in the Keychain for "${account.id}".`, {
      remediation: `Run \`mailbridge account edit ${account.id}\` and set the password.`,
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
  const user = account.smtp.user ?? account.imap.user;
  const dedicated = await readPassword(buildServiceName(account.id, 'smtp'), user);

  if (dedicated !== undefined) {
    logger.debug('dedicated SMTP credential read from the Keychain', { accountId: account.id });

    return dedicated;
  }

  return getImapPassword(account);
}

/**
 * Checks that the items exist without returning their content. This is the only diagnostic allowed
 * on credentials.
 */
export async function hasCredentials(account: Account): Promise<boolean> {
  const password = await readPassword(buildServiceName(account.id, 'imap'), account.imap.user);

  return password !== undefined;
}
