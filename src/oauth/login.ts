import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

import { clearAccessTokens, rememberTokens, requestToken } from './access-token.js';
import { buildAuthorizeUrl, buildCodeExchangeBody, summarizeEntraDescription } from './microsoft.js';
import { createPkcePair, createState } from './pkce.js';

import { storeRefreshToken } from '#secrets/keychain-write';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

/** Long enough for an MFA prompt on the phone, short enough that a forgotten login does not linger. */
const LOGIN_TIMEOUT_MS = 5 * 60_000;

const OPEN_BIN = '/usr/bin/open';

const execFileAsync = promisify(execFile);

/* --------
 * Types
 * -------- */

export type CallbackOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: MailbridgeError }
  /** A request that is not the redirect: a favicon, a second tab. Answered and ignored. */
  | { kind: 'ignored' };

export interface LoginOptions {
  /** Called with the URL before the browser opens, so the caller can print it as a fallback. */
  onAuthorizeUrl?: (url: string) => void;
}

/* --------
 * Helpers
 * -------- */

/**
 * Reads the redirect that the browser delivers to the loopback listener.
 *
 * The `state` check is what makes the code ours: any other process on the machine can send a request
 * to a port it finds open, and only the browser that went through our authorization request knows the
 * value.
 */
export function parseCallback(requestUrl: string, expectedState: string): CallbackOutcome {
  const url = new URL(requestUrl, 'http://localhost');
  const params = url.searchParams;

  if (url.pathname !== '/' || (!params.has('code') && !params.has('error'))) {
    return { kind: 'ignored' };
  }

  if (params.get('state') !== expectedState) {
    return {
      kind:  'error',
      error: new MailbridgeError('oauth_failed', 'The sign-in redirect carried an unexpected state.', {
        remediation: 'Start the sign-in again: the redirect did not come from this request.',
      }),
    };
  }

  const error = params.get('error');

  if (error !== null) {
    const description = summarizeEntraDescription(params.get('error_description') ?? undefined);
    const isConsent = error === 'consent_required' || /AADSTS65001|AADSTS90094/.test(description);

    return {
      kind:  'error',
      error: new MailbridgeError('credential_rejected', `Sign-in refused: ${error}${description.length > 0 ? ` (${description})` : ''}.`, {
        remediation: isConsent
          ? 'An administrator has to grant consent to the app registration, then sign in again.'
          : 'Check the account you signed in with, then start the sign-in again.',
      }),
    };
  }

  const code = params.get('code') ?? '';

  return code.length > 0
    ? { kind: 'code', code }
    : { kind: 'error', error: new MailbridgeError('oauth_failed', 'The sign-in redirect carried an empty code.') };
}

function respond(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    'content-type':  'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'connection':    'close',
  });
  response.end(`${message}\n`);
}

async function listen(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
}

/* --------
 * Implementation
 * -------- */

/**
 * Interactive sign-in: authorization code with PKCE, in the system browser, with the redirect caught by
 * a listener on the loopback interface. Stores the refresh token in the Keychain and nothing on disk.
 *
 * The redirect URI is `http://localhost:<port>`. The app registration declares `http://localhost`, and
 * Entra ignores the port when matching a localhost redirect, so any free port works. `localhost` can
 * resolve to either loopback address depending on the browser, hence a listener on both.
 */
export async function signIn(account: Account, options: LoginOptions = {}): Promise<void> {
  // ---- Validation
  const { auth } = account;

  if (auth.type !== 'oauth2') {
    throw new MailbridgeError('config_invalid', `"${account.id}" does not authenticate with OAuth.`, {
      remediation: 'Its credential is a password: change it with `mailbridge account edit`.',
    });
  }

  // ---- Internal State
  const pkce = createPkcePair();
  const state = createState();

  let settle: ((outcome: { code: string } | { error: unknown }) => void) | undefined;

  const outcome = new Promise<{ code: string } | { error: unknown }>((resolve) => {
    settle = resolve;
  });

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const parsed = parseCallback(request.url ?? '/', state);

    switch (parsed.kind) {
      case 'ignored':
        respond(response, 404, 'Not found.');

        return;
      case 'error':
        respond(response, 400, `Sign-in failed: ${parsed.error.message} You can close this tab.`);
        settle?.({ error: parsed.error });

        return;
      case 'code':
        respond(response, 200, 'Signed in. You can close this tab and go back to the terminal.');
        settle?.({ code: parsed.code });
    }
  };

  // ---- Connection Setup
  const ipv4 = createServer(handler);
  const ipv6 = createServer(handler);

  if (!(await listen(ipv4, 0, '127.0.0.1'))) {
    throw new MailbridgeError('oauth_failed', 'Could not open a port on 127.0.0.1 for the sign-in redirect.');
  }

  const { port } = ipv4.address() as AddressInfo;
  const hasIpv6 = await listen(ipv6, port, '::1');
  const redirectUri = `http://localhost:${port}`;

  const timer = setTimeout(() => {
    settle?.({
      error: new MailbridgeError('oauth_failed', 'The sign-in was not completed within five minutes.', {
        remediation: `Run \`mailbridge account login ${account.id}\` again.`,
      }),
    });
  }, LOGIN_TIMEOUT_MS);

  try {
    // ---- Browser
    const authorizeUrl = buildAuthorizeUrl({
      auth,
      redirectUri,
      state,
      challenge: pkce.challenge,
      loginHint: account.imap.user,
    });

    options.onAuthorizeUrl?.(authorizeUrl);

    await execFileAsync(OPEN_BIN, [authorizeUrl]).catch((cause: unknown) => {
      logger.warn('could not open the browser: the URL has to be opened by hand', { cause });
    });

    const result = await outcome;

    if ('error' in result) {
      throw result.error;
    }

    // ---- Code Exchange
    const tokens = await requestToken(account.id, auth, buildCodeExchangeBody({
      auth,
      code:     result.code,
      redirectUri,
      verifier: pkce.verifier,
    }));

    if (tokens.refreshToken === undefined) {
      throw new MailbridgeError('oauth_failed', 'The sign-in succeeded but no refresh token was issued.', {
        remediation: 'The offline_access permission was not granted: check the consent on the app registration.',
      });
    }

    await storeRefreshToken(account.id, account.imap.user, tokens.refreshToken);

    clearAccessTokens(account.id);
    rememberTokens(account.id, tokens);

    logger.info('OAuth sign-in completed', { accountId: account.id });
  } finally {
    // ---- Cleanup
    // A browser keeps its connection alive after the redirect: without dropping it, the process would
    // stay up until the browser lets go.
    clearTimeout(timer);
    ipv4.close();
    ipv4.closeAllConnections();

    if (hasIpv6) {
      ipv6.close();
      ipv6.closeAllConnections();
    }
  }
}
