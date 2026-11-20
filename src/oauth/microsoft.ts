import { z } from 'zod';

import { MailbridgeError } from '#shared/errors';

import type { OAuth2Auth } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const AUTHORITY = 'https://login.microsoftonline.com';

/**
 * Delegated scopes. The resource prefix is part of the scope and is `outlook.office.com` for IMAP,
 * not the `outlook.office365.com` host the client connects to: Microsoft documents the full string and
 * the two are not interchangeable. `offline_access` is what makes the token endpoint return a refresh
 * token at all.
 *
 * There is no `SMTP.Send`: an OAuth account sends nothing, see `accounts.schema.ts`. A token without
 * that scope cannot send even if something tried to.
 */
export const MICROSOFT_SCOPES = ['https://outlook.office.com/IMAP.AccessAsUser.All', 'offline_access'] as const;

/* --------
 * Types
 * -------- */

export interface AuthorizeRequest {
  auth: OAuth2Auth;
  redirectUri: string;
  state: string;
  challenge: string;
  /** Pre-fills the account in the sign-in page, so the wrong one is harder to pick. */
  loginHint: string;
}

export interface CodeExchange {
  auth: OAuth2Auth;
  code: string;
  redirectUri: string;
  verifier: string;
}

export interface TokenSet {
  accessToken: string;
  /** Absent when the server did not issue one: then the stored refresh token stays valid. */
  refreshToken: string | undefined;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/* --------
 * Schemas
 * -------- */

const tokenResponseSchema = z.object({
  access_token:  z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in:    z.coerce.number().int().positive(),
  token_type:    z.string(),
});

const errorResponseSchema = z.object({
  error:             z.string(),
  error_description: z.string().optional(),
});

/* --------
 * Helpers
 * -------- */

function endpoint(auth: OAuth2Auth, path: 'authorize' | 'token'): string {
  return `${AUTHORITY}/${encodeURIComponent(auth.tenantId)}/oauth2/v2.0/${path}`;
}

/**
 * The readable part of an Entra error description: the `AADSTSnnnnn` code and its sentence. What
 * follows is trace id, correlation id and timestamp, useful to Microsoft support and noise to anybody
 * else. The token endpoint puts them on the same line (measured on 2026-11-20), other paths on separate
 * lines: both are cut.
 */
export function summarizeEntraDescription(description: string | undefined): string {
  const firstLine = (description ?? '').split(/\r?\n/)[0] ?? '';

  return firstLine.split(/\s+Trace ID:/)[0]?.trim() ?? '';
}

/* --------
 * Requests
 * -------- */

/**
 * The URL the browser is sent to. Authorization code flow with PKCE, as Microsoft recommends for
 * desktop apps; no client secret exists for a public client.
 */
export function buildAuthorizeUrl(request: AuthorizeRequest): string {
  const url = new URL(endpoint(request.auth, 'authorize'));

  url.search = new URLSearchParams({
    client_id:             request.auth.clientId,
    response_type:         'code',
    redirect_uri:          request.redirectUri,
    response_mode:         'query',
    scope:                 MICROSOFT_SCOPES.join(' '),
    state:                 request.state,
    code_challenge:        request.challenge,
    code_challenge_method: 'S256',
    login_hint:            request.loginHint,
  }).toString();

  return url.toString();
}

export function buildCodeExchangeBody(exchange: CodeExchange): URLSearchParams {
  return new URLSearchParams({
    client_id:     exchange.auth.clientId,
    grant_type:    'authorization_code',
    code:          exchange.code,
    redirect_uri:  exchange.redirectUri,
    code_verifier: exchange.verifier,
    scope:         MICROSOFT_SCOPES.join(' '),
  });
}

export function buildRefreshBody(auth: OAuth2Auth, refreshToken: string): URLSearchParams {
  return new URLSearchParams({
    client_id:     auth.clientId,
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
    scope:         MICROSOFT_SCOPES.join(' '),
  });
}

export function tokenEndpoint(auth: OAuth2Auth): string {
  return endpoint(auth, 'token');
}

/* --------
 * Responses
 * -------- */

/**
 * Maps a token endpoint response to a token set, or to an error that says what to do.
 *
 * `accountId` is only used to write the remediation: the command to run is the useful part of the
 * message, and it needs the id.
 */
export function parseTokenResponse(accountId: string, status: number, body: unknown, now: number = Date.now()): TokenSet {
  // ---- Success
  if (status >= 200 && status < 300) {
    const parsed = tokenResponseSchema.safeParse(body);

    if (!parsed.success) {
      throw new MailbridgeError('oauth_failed', 'The token endpoint answered with an unexpected body.', {
        remediation: `Try again with \`mailbridge account login ${accountId}\`.`,
      });
    }

    return {
      accessToken:  parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt:    now + parsed.data.expires_in * 1000,
    };
  }

  // ---- Error Handling
  const parsed = errorResponseSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error : `http_${status}`;
  const detail = parsed.success ? summarizeEntraDescription(parsed.data.error_description) : '';
  const suffix = detail.length > 0 ? ` (${detail})` : '';

  if (/AADSTS65001/.test(detail) || code === 'consent_required') {
    throw new MailbridgeError('credential_rejected', `The tenant has not consented to this app${suffix}.`, {
      remediation: 'An administrator has to grant consent to the app registration, then run '
        + `\`mailbridge account login ${accountId}\`.`,
    });
  }

  if (code === 'invalid_grant' || code === 'interaction_required') {
    throw new MailbridgeError('credential_rejected', `The stored sign-in for "${accountId}" is no longer valid${suffix}.`, {
      remediation: `Sign in again with \`mailbridge account login ${accountId}\`. A password change or a revoked session causes this.`,
    });
  }

  throw new MailbridgeError('oauth_failed', `The token endpoint refused the request: ${code}${suffix}.`, {
    remediation: 'Check tenantId and clientId in accounts.json against the app registration.',
  });
}
