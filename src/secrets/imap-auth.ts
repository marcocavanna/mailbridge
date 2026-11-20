import { getImapPassword } from './keychain.js';

import { getAccessToken } from '#oauth/access-token';

import type { Account } from '#config/accounts.schema';

/* --------
 * Types
 * -------- */

/**
 * The `auth` block imapflow takes. With `accessToken` it authenticates with XOAUTH2 (or OAUTHBEARER
 * when the server offers it), with `pass` with PLAIN or LOGIN.
 */
export type ImapAuth =
  | { user: string; pass: string }
  | { user: string; accessToken: string };

/* --------
 * Implementation
 * -------- */

/**
 * The IMAP credential of an account, whatever kind it is. The single place that knows the difference:
 * the pool and the health check call this and never branch on `auth.type` themselves.
 */
export async function resolveImapAuth(account: Account): Promise<ImapAuth> {
  if (account.auth.type === 'oauth2') {
    return { user: account.imap.user, accessToken: await getAccessToken(account) };
  }

  return { user: account.imap.user, pass: await getImapPassword(account) };
}
