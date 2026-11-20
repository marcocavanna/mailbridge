import { buildRefreshBody, parseTokenResponse, tokenEndpoint } from './microsoft.js';

import { missingCredentialRemediation, readRefreshToken } from '#secrets/keychain';
import { storeRefreshToken } from '#secrets/keychain-write';
import { MailbridgeError } from '#shared/errors';
import { logger, registerSecret } from '#shared/logger';

import type { TokenSet } from './microsoft.js';
import type { Account, OAuth2Auth } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const TOKEN_TIMEOUT_MS = 20_000;

/**
 * An access token closer than this to expiry is renewed before use. Exchange checks the token at
 * authentication, and a connection opened with one minute left is a connection that fails on the next
 * reconnect: the margin keeps that out of the way.
 */
const EXPIRY_MARGIN_MS = 5 * 60_000;

/* --------
 * Internal State
 * -------- */

/** Access tokens live only here, in memory. They are never written anywhere. */
const cache = new Map<string, TokenSet>();

/**
 * Refreshes already running, per account. Two tools opening a connection at the same moment share
 * one request instead of racing two rotations of the same refresh token.
 */
const inFlight = new Map<string, Promise<string>>();

/* --------
 * Implementation
 * -------- */

/**
 * POSTs to the token endpoint and maps the answer. Shared by the sign-in and by the refresh.
 */
export async function requestToken(
  accountId: string,
  auth: OAuth2Auth,
  body: URLSearchParams,
  now: number = Date.now(),
): Promise<TokenSet> {
  let response: Response;

  try {
    response = await fetch(tokenEndpoint(auth), {
      method:  'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal:  AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new MailbridgeError('oauth_failed', 'The Microsoft token endpoint could not be reached.', {
      remediation: 'Check the network connection and try again.',
      cause,
    });
  }

  const payload: unknown = await response.json().catch(() => undefined);
  const tokens = parseTokenResponse(accountId, response.status, payload, now);

  registerSecret(tokens.accessToken);

  if (tokens.refreshToken !== undefined) {
    registerSecret(tokens.refreshToken);
  }

  return tokens;
}

async function refresh(account: Account, auth: OAuth2Auth, now: number): Promise<string> {
  // ---- Credentials
  const refreshToken = await readRefreshToken(account);

  if (refreshToken === undefined) {
    throw new MailbridgeError('credential_missing', `"${account.id}" has never signed in.`, {
      remediation: missingCredentialRemediation(account),
    });
  }

  // ---- Refresh
  const tokens = await requestToken(account.id, auth, buildRefreshBody(auth, refreshToken), now);

  /*
   * Microsoft replaces the refresh token on every use and does not revoke the old one, so storing the
   * new one is what keeps the 90-day inactivity window sliding. A concurrent process that refreshed
   * with the old token is not harmed either.
   */
  if (tokens.refreshToken !== undefined && tokens.refreshToken !== refreshToken) {
    await storeRefreshToken(account.id, account.imap.user, tokens.refreshToken);
  }

  cache.set(account.id, tokens);

  logger.debug('OAuth access token renewed', { accountId: account.id, expiresAt: new Date(tokens.expiresAt).toISOString() });

  return tokens.accessToken;
}

/**
 * A valid access token for an OAuth account, renewing it from the stored refresh token when needed.
 */
export async function getAccessToken(account: Account, now: number = Date.now()): Promise<string> {
  // ---- Validation
  const { auth } = account;

  if (auth.type !== 'oauth2') {
    throw new MailbridgeError('config_invalid', `"${account.id}" does not authenticate with OAuth.`, {
      remediation: 'Only OAuth accounts have access tokens: this one uses the password in the Keychain.',
    });
  }

  // ---- Cached
  const cached = cache.get(account.id);

  if (cached !== undefined && cached.expiresAt - now > EXPIRY_MARGIN_MS) {
    return cached.accessToken;
  }

  // ---- Refresh, shared with whoever is already refreshing
  const running = inFlight.get(account.id);

  if (running !== undefined) {
    return running;
  }

  const pending = refresh(account, auth, now).finally(() => {
    inFlight.delete(account.id);
  });

  inFlight.set(account.id, pending);

  return pending;
}

/**
 * Seeds the cache with the tokens a sign-in just produced, so the first connection after it does not
 * pay a refresh.
 */
export function rememberTokens(accountId: string, tokens: TokenSet): void {
  cache.set(accountId, tokens);
}

/**
 * Forgets every cached access token. For tests, and for a sign-in that replaces the account's tokens.
 */
export function clearAccessTokens(accountId?: string): void {
  if (accountId === undefined) {
    cache.clear();

    return;
  }

  cache.delete(accountId);
}
