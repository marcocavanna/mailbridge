import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import { buildServiceName } from './keychain.js';

import { MailbridgeError } from '#shared/errors';
import { logger, registerSecret } from '#shared/logger';

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
 * Stores an OAuth refresh token, replacing the previous one.
 *
 * Unlike a password, a refresh token is produced by this process, so this function has to take the
 * value: there is no human to type it into `security`. It still never reaches a command line, where
 * `ps` would show it. The command goes to `security -i` on **stdin**, and the value travels hex
 * encoded through `-X`, which also removes any question of quoting inside the interactive parser.
 *
 * **`-T` only when the item is created, never when it is updated.** On an existing item `-T` is a change
 * of its access list, and macOS asks the user for the login password to allow it: once per token
 * rotation, which means hourly under the MCP server, and a hang on the unattended path. The access list
 * set at creation already trusts `security`, and replacing the data needs nothing more (measured on
 * 2026-11-20: an update without `-T` completes with no prompt).
 */
export async function storeRefreshToken(accountId: string, user: string, refreshToken: string): Promise<void> {
  // ---- Validation
  // The user name is the only other free value on the command line: a quote, a space or a newline in
  // it could smuggle a second command into the interactive session.
  if (!/^[^\s"'\\]+$/.test(user)) {
    throw new MailbridgeError('config_invalid', `The IMAP username of "${accountId}" cannot be used as a Keychain account name.`, {
      remediation: 'Use the mailbox address as the IMAP username.',
    });
  }

  registerSecret(refreshToken);

  // ---- Query Build
  const service = buildServiceName(accountId, 'oauth');
  const hexToken = Buffer.from(refreshToken, 'utf8').toString('hex');
  const update = ['add-generic-password', '-U', '-s', service, '-a', user, '-X', hexToken].join(' ');
  const create = [
    'add-generic-password',
    '-s', service,
    '-a', user,
    '-D', '"mailbridge OAuth refresh token"',
    '-T', SECURITY_BIN,
    '-X', hexToken,
  ].join(' ');

  // ---- Write
  if (await keychainItemExists(service, user)) {
    await runInteractiveSecurity(accountId, update);
  } else {
    // Created without `-U`: if another process created it in the meantime this fails instead of
    // touching its access list, and the update path takes over.
    await runInteractiveSecurity(accountId, create).catch(async () => runInteractiveSecurity(accountId, update));
  }

  logger.debug('OAuth refresh token stored in the Keychain', { accountId, service });
}

/* --------
 * Helpers
 * -------- */

/** Long enough for a busy machine, short enough that a Keychain dialog cannot hang a tool call. */
const SECURITY_WRITE_TIMEOUT_MS = 15_000;

/**
 * Whether the item exists. Without `-w` the secret is not read, so this never prompts.
 */
async function keychainItemExists(service: string, user: string): Promise<boolean> {
  try {
    await execFileAsync(SECURITY_BIN, ['find-generic-password', '-s', service, '-a', user], { maxBuffer: 16_384 });

    return true;
  } catch {
    return false;
  }
}

/**
 * Hands one command to `security -i` on stdin, so no value reaches the process table.
 *
 * Bounded in time: if macOS ever shows a dialog, `security` waits for it indefinitely, and a refresh
 * stuck behind it would hang every tool call of the account. Better an error that names the cause.
 */
async function runInteractiveSecurity(accountId: string, command: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(SECURITY_BIN, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });

    let stderr = '';

    const timer = setTimeout(() => {
      child.kill();
      reject(new MailbridgeError('credential_missing', 'The Keychain did not answer: it is probably waiting for a confirmation.', {
        remediation: `Sign in again with \`mailbridge account login ${accountId}\` from a terminal.`,
      }));
    }, SECURITY_WRITE_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (cause) => {
      clearTimeout(timer);
      reject(cause);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve();

        return;
      }

      const reason = stderr.trim() || `security exited with code ${code ?? 'unknown'}`;

      reject(new MailbridgeError('credential_missing', `Could not store the OAuth refresh token: ${reason}.`, {
        remediation: `Sign in again with \`mailbridge account login ${accountId}\`.`,
      }));
    });

    child.stdin.end(`${command}\n`);
  });
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
