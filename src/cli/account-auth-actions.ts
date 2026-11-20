import { pickAccount, requireOverview } from './account-resolve.js';
import { askText, prompts, required } from './prompt-helpers.js';
import { colors } from './ui.js';

import { authSchema } from '#config/accounts.schema';
import { readConfigOrEmpty } from '#config/write-accounts';
import { getAccessToken } from '#oauth/access-token';
import { runImapTunnel } from '#mirror/imap-tunnel';
import { signIn } from '#oauth/login';
import { promptAndStorePassword } from '#secrets/keychain-write';
import { MailbridgeError } from '#shared/errors';

import type { Account, AccountAuth } from '#config/accounts.schema';

/* --------
 * Collection
 * -------- */

/**
 * Asks how the account authenticates. With `current` every prompt starts from the present value.
 */
export async function collectAuth(current?: AccountAuth): Promise<AccountAuth> {
  const type = required(await prompts.select({
    message:      'How does the account sign in?',
    initialValue: current?.type ?? 'password',
    options:      [
      { value: 'password', label: 'Password', hint: 'stored in the Keychain' },
      { value: 'oauth2', label: 'Microsoft 365 (OAuth)', hint: 'Exchange Online: needs an app registration in the tenant' },
    ],
  }));

  if (type === 'password') {
    return { type: 'password' };
  }

  const existing = current?.type === 'oauth2' ? current : undefined;

  prompts.log.info([
    'Both values come from the app registration in Microsoft Entra, on its Overview page.',
    'Neither is a secret: the app is a public client and has no client secret.',
  ].join('\n  '));

  const tenantId = await askText('  Directory (tenant) ID', {
    ...(existing === undefined ? { placeholder: '00000000-0000-0000-0000-000000000000' } : { initialValue: existing.tenantId }),
    validate: (value) => (
      authSchema.safeParse({ type: 'oauth2', provider: 'microsoft', tenantId: value, clientId: '00000000-0000-0000-0000-000000000000' }).success
        ? undefined
        : 'Use the directory (tenant) ID, or a domain of the tenant.'
    ),
  });

  const clientId = await askText('  Application (client) ID', {
    ...(existing === undefined ? { placeholder: '00000000-0000-0000-0000-000000000000' } : { initialValue: existing.clientId }),
    validate: (value) => (
      authSchema.safeParse({ type: 'oauth2', provider: 'microsoft', tenantId, clientId: value }).success
        ? undefined
        : 'Not a valid application ID.'
    ),
  });

  return { type: 'oauth2', provider: 'microsoft', tenantId, clientId };
}

/* --------
 * Credential
 * -------- */

/**
 * Interactive OAuth sign-in. The browser does the authentication; the terminal only waits, and shows
 * the URL in case the browser did not open.
 */
export async function signInFlow(account: Account): Promise<void> {
  // No spinner here: the URL has to stay readable while the terminal waits, and clack redraws a spinner
  // line over anything logged during it.
  await signIn(account, {
    onAuthorizeUrl: (url) => {
      prompts.log.step(`Opening the browser to sign in as ${colors.bold(account.imap.user)}. Waiting up to five minutes.`);
      prompts.log.info(`If the browser does not open, open this address by hand:\n  ${colors.dim(url)}`);
    },
  });

  prompts.log.success(`Signed in: the refresh token for "${account.id}" is in the Keychain.`);
}

/**
 * Stores the credential of a freshly configured account, whatever its kind.
 */
export async function storeCredentialFor(account: Account): Promise<void> {
  if (account.auth.type === 'oauth2') {
    prompts.log.step('Signing in with Microsoft: the password is typed in the browser, never here');
    await signInFlow(account);

    return;
  }

  prompts.log.step('Storing the credential in the Keychain — macOS asks for the password, it never passes through here');

  await promptAndStorePassword(account.id, account.imap.user, 'imap');

  if (account.smtp?.user !== undefined && account.smtp.user !== account.imap.user) {
    prompts.log.step('The SMTP username differs: storing the SMTP credential as well');
    await promptAndStorePassword(account.id, account.smtp.user, 'smtp');
  }
}

/* --------
 * Commands
 * -------- */

/**
 * `mailbridge account login`: signs an OAuth account in again, after a revoked session or a password
 * change.
 */
export async function loginAccount(accountId?: string): Promise<void> {
  const target = accountId ?? (await pickAccount('Which account should sign in?'));
  const { account } = await requireOverview(target);

  if (account.auth.type !== 'oauth2') {
    throw new MailbridgeError('config_invalid', `"${target}" signs in with a password, not with OAuth.`, {
      remediation: `Change the password with \`mailbridge account edit ${target}\`.`,
    });
  }

  await signInFlow(account);
}

/**
 * Resolves an account straight from the configuration, without the Keychain and mirror reads of the
 * overview: the token command runs on every IMAP login of a script and has to stay cheap.
 */
export async function requireAccountById(accountId: string): Promise<Account> {
  const config = await readConfigOrEmpty();
  const account = config.accounts.find((entry) => entry.id === accountId);

  if (account === undefined) {
    throw new MailbridgeError('account_not_found', `No account with id "${accountId}".`, {
      remediation: 'List them with `mailbridge account list`.',
    });
  }

  return account;
}

/**
 * `mailbridge imap-tunnel`: the command mbsync runs to reach an OAuth account. See `imap-tunnel.ts`.
 */
export async function runTunnelCommand(accountId: string): Promise<void> {
  const account = await requireAccountById(accountId);

  if (account.auth.type !== 'oauth2') {
    throw new MailbridgeError('config_invalid', `"${accountId}" signs in with a password: mbsync reaches it directly.`);
  }

  await runImapTunnel({
    account,
    getAccessToken: async () => getAccessToken(account),
    input:          process.stdin,
    output:         process.stdout,
  });
}

/**
 * `mailbridge account token`: prints a valid access token on stdout and nothing else, for tools that
 * talk IMAP themselves (maildraft, and mbsync's `PassCmd` should the mirror ever support OAuth).
 *
 * It exposes what the Keychain already exposes to any process running as the user, for an hour
 * instead of indefinitely. No clack, no banner: stdout is the token.
 */
export async function printAccessToken(account: Account): Promise<void> {
  const token = await getAccessToken(account);

  process.stdout.write(`${token}\n`);
}
