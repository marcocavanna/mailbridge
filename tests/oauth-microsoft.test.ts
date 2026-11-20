import { describe, expect, it } from 'vitest';

import {
  buildAuthorizeUrl,
  buildCodeExchangeBody,
  buildRefreshBody,
  parseTokenResponse,
  tokenEndpoint,
} from '#oauth/microsoft';
import { MailbridgeError } from '#shared/errors';

import type { OAuth2Auth } from '#config/accounts.schema';

/* --------
 * Fixture
 * -------- */

const auth: OAuth2Auth = {
  type:     'oauth2',
  provider: 'microsoft',
  tenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
};

const NOW = 1_800_000_000_000;

function thrown(action: () => unknown): MailbridgeError {
  try {
    action();
  } catch (cause) {
    if (cause instanceof MailbridgeError) {
      return cause;
    }
  }

  throw new MailbridgeError('oauth_failed', 'expected a MailbridgeError');
}

/* --------
 * Requests
 * -------- */

describe('authorization request', () => {
  const url = new URL(buildAuthorizeUrl({
    auth,
    redirectUri: 'http://localhost:51234',
    state:       'the-state',
    challenge:   'the-challenge',
    loginHint:   'someone@example.com',
  }));

  it('targets the tenant, not a multi-tenant alias', () => {
    expect(`${url.origin}${url.pathname}`)
      .toBe('https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/authorize');
  });

  it('asks for IMAP and offline_access, with the outlook.office.com resource, and nothing that sends', () => {
    expect(url.searchParams.get('scope')).toBe('https://outlook.office.com/IMAP.AccessAsUser.All offline_access');
    expect(url.searchParams.get('scope')).not.toMatch(/SMTP|Send/i);
  });

  it('uses the code flow with an S256 challenge and carries state and hint', () => {
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('the-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:51234');
    expect(url.searchParams.get('login_hint')).toBe('someone@example.com');
  });
});

describe('token requests', () => {
  it('redeems the code with the verifier and no client secret', () => {
    const body = buildCodeExchangeBody({ auth, code: 'c0de', redirectUri: 'http://localhost:51234', verifier: 'v3rifier' });

    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('v3rifier');
    expect(body.get('redirect_uri')).toBe('http://localhost:51234');
    expect(body.has('client_secret')).toBe(false);
  });

  it('refreshes with the stored token and no client secret', () => {
    const body = buildRefreshBody(auth, 'r3fresh');

    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('r3fresh');
    expect(body.has('client_secret')).toBe(false);
  });

  it('posts to the tenant token endpoint', () => {
    expect(tokenEndpoint(auth))
      .toBe('https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token');
  });
});

/* --------
 * Responses
 * -------- */

describe('token response', () => {
  it('maps a success, with the expiry in absolute time', () => {
    const tokens = parseTokenResponse('work', 200, {
      access_token:  'at',
      refresh_token: 'rt',
      expires_in:    3599,
      token_type:    'Bearer',
    }, NOW);

    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_599_000 });
  });

  it('accepts a success without a new refresh token', () => {
    const tokens = parseTokenResponse('work', 200, { access_token: 'at', expires_in: '3600', token_type: 'Bearer' }, NOW);

    expect(tokens.refreshToken).toBeUndefined();
  });

  it('turns invalid_grant into "sign in again", naming the command', () => {
    const error = thrown(() => parseTokenResponse('work', 400, {
      error:             'invalid_grant',
      error_description: 'AADSTS50173: The provided grant has expired.\r\nTrace ID: abc\r\nCorrelation ID: def',
    }));

    expect(error.code).toBe('credential_rejected');
    expect(error.toAgentMessage()).toContain('mailbridge account login work');
    expect(error.toAgentMessage()).toContain('AADSTS50173');
    expect(error.toAgentMessage()).not.toContain('Trace ID');
  });

  it('cuts trace and correlation ids that the token endpoint appends on the same line', () => {
    // Shape measured against login.microsoftonline.com on 2026-11-20.
    const error = thrown(() => parseTokenResponse('work', 400, {
      error:             'invalid_grant',
      error_description: 'AADSTS9002313: Invalid request. Request is malformed or invalid. Trace ID: cb23 Correlation ID: 9b90 Timestamp: 2026-11-20 15:03:57Z',
    }));

    expect(error.message).toContain('(AADSTS9002313: Invalid request. Request is malformed or invalid.)');
    expect(error.message).not.toMatch(/Trace ID|Correlation|Timestamp/);
  });

  it('recognizes a missing consent and points at the administrator', () => {
    const error = thrown(() => parseTokenResponse('work', 400, {
      error:             'invalid_grant',
      error_description: 'AADSTS65001: The user or administrator has not consented to use the application.',
    }));

    expect(error.code).toBe('credential_rejected');
    expect(error.toAgentMessage()).toMatch(/administrator has to grant consent/);
  });

  it('reports a malformed success as a failure, not as a token', () => {
    const error = thrown(() => parseTokenResponse('work', 200, { token_type: 'Bearer' }));

    expect(error.code).toBe('oauth_failed');
  });

  it('reports a non-JSON error with the HTTP status', () => {
    const error = thrown(() => parseTokenResponse('work', 503, undefined));

    expect(error.code).toBe('oauth_failed');
    expect(error.message).toContain('http_503');
  });
});
