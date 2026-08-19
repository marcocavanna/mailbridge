import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { buildServiceName } from './keychain.js';

import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { CredentialKind } from './keychain.js';

/* --------
 * Constants
 * -------- */

const SECURITY_BIN = '/usr/bin/security';

const execFileAsync = promisify(execFile);

/* --------
 * Implementation
 * -------- */

/**
 * Stores or updates a credential in the Keychain, delegating the prompt to `security` itself.
 *
 * The password is typed **inside** `security`, on the terminal's stdio: it never passes through this
 * process, never shows up in `ps`, and is never visible to whoever wrote this code. That is why this
 * function has no `password` parameter — and must not acquire one.
 *
 * `-U` upserts: the same call serves to create and to change. Note that the ACL is applied at item
 * **creation**: a credential stored by an earlier version, without `-T`, has to be rewritten before
 * the scheduled sync can read it without a prompt.
 */
export async function promptAndStorePassword(
  accountId: string,
  user: string,
  kind: CredentialKind = 'imap',
): Promise<void> {
  const service = buildServiceName(accountId, kind);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      SECURITY_BIN,
      [
        'add-generic-password',
        '-U',
        '-s', service,
        '-a', user,
        '-D', `mailbridge ${kind.toUpperCase()} password`,
        /*
         * Authorizes `security` to read the item back without asking for confirmation. The scheduled
         * sync needs this: an unattended LaunchAgent that hits a Keychain prompt does not fail with
         * an error, it hangs silently.
         *
         * Deliberately narrow — `-T` with a single binary, not `-A`, which would open the item to
         * every application.
         */
        '-T', SECURITY_BIN,
        '-w',
      ],
      { stdio: 'inherit' },
    );

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();

        return;
      }

      reject(new MailbridgeError('credential_missing', `security exited with code ${code ?? 'unknown'}.`, {
        remediation: 'Try again, or store the credential by hand with `security add-generic-password`.',
      }));
    });
  });

  logger.info('credential stored in the Keychain', { accountId, kind, service });
}

/**
 * Deletes a credential from the Keychain.
 *
 * Irreversible by construction: this program does not know the password, so it cannot recreate it.
 * The caller must already have obtained an explicit confirmation.
 *
 * Returns `false` when the item was not there: that is not an error.
 */
export async function deletePassword(accountId: string, kind: CredentialKind = 'imap'): Promise<boolean> {
  const service = buildServiceName(accountId, kind);

  try {
    await execFileAsync(SECURITY_BIN, ['delete-generic-password', '-s', service], { maxBuffer: 4096 });

    logger.info('credential deleted from the Keychain', { accountId, kind, service });

    return true;
  } catch {
    return false;
  }
}
