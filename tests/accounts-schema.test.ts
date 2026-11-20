import { describe, expect, it } from 'vitest';

import { accountSchema } from '#config/accounts.schema';

/* --------
 * Fixture
 * -------- */

const oauth = {
  type:     'oauth2',
  provider: 'microsoft',
  tenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
};

const base = {
  id:      'work',
  label:   'Work',
  address: 'someone@example.com',
  imap:    { host: 'imap.example.com', user: 'someone@example.com' },
};

function issues(input: unknown): string[] {
  const result = accountSchema.safeParse(input);

  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/* --------
 * Authentication
 * -------- */

describe('account authentication', () => {
  it('defaults to password, so configurations written before OAuth keep their meaning', () => {
    const account = accountSchema.parse({ ...base, smtp: { host: 'smtp.example.com' } });

    expect(account.auth).toEqual({ type: 'password' });
  });

  it('accepts an OAuth account with no SMTP and the mirror off', () => {
    expect(issues({ ...base, auth: oauth, mirror: { enabled: false } })).toEqual([]);
  });

  it('accepts an OAuth account with the mirror on: mbsync goes through the loopback proxy', () => {
    expect(issues({ ...base, auth: oauth })).toEqual([]);
  });

  it('refuses an OAuth account that declares SMTP: it would need a scope that can send', () => {
    expect(issues({ ...base, auth: oauth, mirror: { enabled: false }, smtp: { host: 'smtp.office365.com', port: 587, secure: false } }))
      .toEqual([expect.stringMatching(/^smtp: sending is not supported/)]);
  });

  it('refuses the multi-tenant aliases: the app is registered in one tenant', () => {
    for (const tenantId of ['common', 'organizations', 'consumers']) {
      expect(issues({ ...base, auth: { ...oauth, tenantId }, mirror: { enabled: false } })).not.toEqual([]);
    }
  });

  it('accepts a tenant domain in place of the id', () => {
    expect(issues({ ...base, auth: { ...oauth, tenantId: 'contoso.onmicrosoft.com' }, mirror: { enabled: false } })).toEqual([]);
  });

  it('refuses a client id that is not a GUID', () => {
    expect(issues({ ...base, auth: { ...oauth, clientId: 'mailbridge' }, mirror: { enabled: false } })).not.toEqual([]);
  });

  it('accepts a password account without SMTP: it reads and prepares drafts only', () => {
    expect(issues(base)).toEqual([]);
  });
});
