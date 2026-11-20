import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { clearAccessTokens, getAccessToken } from '#oauth/access-token';
import { readRefreshToken } from '#secrets/keychain';
import { storeRefreshToken } from '#secrets/keychain-write';
import { redact } from '#shared/logger';

import type { Account } from '#config/accounts.schema';

/* --------
 * Mocks
 * -------- */

/*
 * The Keychain is the boundary: the suite never touches the real one (see testing.md). What is under
 * test is what this module does with the token endpoint's answer.
 */
vi.mock('#secrets/keychain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#secrets/keychain')>()),
  readRefreshToken: vi.fn(),
}));

vi.mock('#secrets/keychain-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#secrets/keychain-write')>()),
  storeRefreshToken: vi.fn(),
}));

/* --------
 * Fixture
 * -------- */

const NOW = 1_800_000_000_000;

const account: Account = accountSchema.parse({
  id:      'work',
  label:   'Work',
  address: 'someone@example.com',
  auth:    {
    type:     'oauth2',
    provider: 'microsoft',
    tenantId: '11111111-2222-3333-4444-555555555555',
    clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  },
  imap:   { host: 'outlook.office365.com', user: 'someone@example.com' },
  mirror: { enabled: false },
});

function tokenResponse(accessToken: string, refreshToken?: string): Response {
  return new Response(JSON.stringify({
    access_token: accessToken,
    expires_in:   3600,
    token_type:   'Bearer',
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  clearAccessTokens();
  vi.mocked(readRefreshToken).mockResolvedValue('stored-refresh-token');
  vi.mocked(storeRefreshToken).mockResolvedValue();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/* --------
 * Behaviour
 * -------- */

describe('access token', () => {
  it('stores the rotated refresh token, so the 90-day window keeps sliding', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'rotated-refresh-token'));

    await expect(getAccessToken(account, NOW)).resolves.toBe('access-1');
    expect(storeRefreshToken).toHaveBeenCalledWith('work', 'someone@example.com', 'rotated-refresh-token');
  });

  it('leaves the stored refresh token alone when none comes back', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1'));

    await getAccessToken(account, NOW);

    expect(storeRefreshToken).not.toHaveBeenCalled();
  });

  it('reuses a token far from expiry and renews one close to it', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse('access-1'))
      .mockResolvedValueOnce(tokenResponse('access-2'));

    await getAccessToken(account, NOW);

    await expect(getAccessToken(account, NOW + 30 * 60_000)).resolves.toBe('access-1');
    // Inside the five-minute margin before the hour runs out.
    await expect(getAccessToken(account, NOW + 56 * 60_000)).resolves.toBe('access-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares one refresh between concurrent callers instead of racing two rotations', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('access-1', 'rotated'));

    const tokens = await Promise.all([getAccessToken(account, NOW), getAccessToken(account, NOW)]);

    expect(tokens).toEqual(['access-1', 'access-1']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks for a sign-in when no refresh token was ever stored', async () => {
    vi.mocked(readRefreshToken).mockResolvedValueOnce(undefined);

    await expect(getAccessToken(account, NOW)).rejects.toThrow(/never signed in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers both tokens as secrets, so no log can print them', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse('access-token-value', 'refresh-token-value'));

    await getAccessToken(account, NOW);

    expect(redact('a=access-token-value r=refresh-token-value')).toBe('a=[redacted] r=[redacted]');
  });

  it('refuses a password account: it has no token to give', async () => {
    const passwordAccount = accountSchema.parse({ ...account, auth: { type: 'password' } });

    await expect(getAccessToken(passwordAccount, NOW)).rejects.toThrow(/does not authenticate with OAuth/);
  });
});
