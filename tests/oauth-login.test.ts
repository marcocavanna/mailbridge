import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { signIn } from '#oauth/login';
import { storeRefreshToken } from '#secrets/keychain-write';

import type { Account } from '#config/accounts.schema';

/* --------
 * Mocks
 * -------- */

/*
 * The browser and the Keychain are replaced; the loopback listener is real. What this proves is the part
 * that cannot be seen from a unit: the redirect reaches the listener, the state is checked there, the
 * code is redeemed with the same redirect URI, and the listeners let go so the process can exit.
 */
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: vi.fn((_file: string, _args: string[], callback: (error: null, stdout: string, stderr: string) => void) => {
    callback(null, '', '');
  }),
}));

vi.mock('#secrets/keychain-write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#secrets/keychain-write')>()),
  storeRefreshToken: vi.fn(),
}));

/* --------
 * Fixture
 * -------- */

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

const realFetch = globalThis.fetch;

const tokenEndpointCalls: URLSearchParams[] = [];

beforeEach(() => {
  tokenEndpointCalls.length = 0;
  vi.mocked(storeRefreshToken).mockResolvedValue();

  // Requests to the loopback go through the real fetch; only the token endpoint is answered here.
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);

    if (url.startsWith('https://login.microsoftonline.com/')) {
      tokenEndpointCalls.push(new URLSearchParams(String(init?.body)));

      return new Response(JSON.stringify({
        access_token:  'access-from-login',
        refresh_token: 'refresh-from-login',
        expires_in:    3600,
        token_type:    'Bearer',
      }), { status: 200 });
    }

    return realFetch(input, init);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * Starts a sign-in and hands back the authorization request it would have opened in the browser.
 */
async function startSignIn(): Promise<{ done: Promise<void>; authorize: URL }> {
  let resolveUrl: (url: URL) => void = () => undefined;
  const authorizeUrl = new Promise<URL>((resolve) => {
    resolveUrl = resolve;
  });

  const done = signIn(account, { onAuthorizeUrl: (url) => resolveUrl(new URL(url)) });

  return { done, authorize: await authorizeUrl };
}

/* --------
 * Behaviour
 * -------- */

describe('interactive sign-in', () => {
  it('redeems the code delivered to the loopback and stores the refresh token', async () => {
    const { done, authorize } = await startSignIn();
    const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
    const state = authorize.searchParams.get('state') ?? '';

    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/);

    const callback = await realFetch(`${redirectUri.replace('localhost', '127.0.0.1')}/?code=the-code&state=${state}`);

    expect(callback.status).toBe(200);
    await expect(done).resolves.toBeUndefined();

    expect(tokenEndpointCalls[0]?.get('code')).toBe('the-code');
    expect(tokenEndpointCalls[0]?.get('redirect_uri')).toBe(redirectUri);
    expect(storeRefreshToken).toHaveBeenCalledWith('work', 'someone@example.com', 'refresh-from-login');
  });

  it('refuses a redirect with a forged state and redeems nothing', async () => {
    const { done, authorize } = await startSignIn();
    const redirectUri = authorize.searchParams.get('redirect_uri') ?? '';

    // Attached before the request: the rejection happens while the request is being answered.
    const refused = expect(done).rejects.toThrow(/unexpected state/);
    const callback = await realFetch(`${redirectUri.replace('localhost', '127.0.0.1')}/?code=the-code&state=forged`);

    expect(callback.status).toBe(400);
    await refused;
    expect(tokenEndpointCalls).toHaveLength(0);
    expect(storeRefreshToken).not.toHaveBeenCalled();
  });

  it('releases the port once finished', async () => {
    const { done, authorize } = await startSignIn();
    const loopback = (authorize.searchParams.get('redirect_uri') ?? '').replace('localhost', '127.0.0.1');
    const state = authorize.searchParams.get('state') ?? '';

    await realFetch(`${loopback}/?code=c&state=${state}`);
    await done;

    await expect(realFetch(`${loopback}/?code=c&state=${state}`)).rejects.toThrow();
  });
});
