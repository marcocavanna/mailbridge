import { describe, expect, it } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { buildAccountBlock } from '#mirror/mbsyncrc';

/* --------
 * Helpers
 * -------- */

function makeAccount(imapExtras: Record<string, unknown> = {}) {
  return accountSchema.parse({
    id:      'work',
    label:   'Work',
    address: 'you@example.com',
    imap:    { host: 'imap.example.com', user: 'you@example.com', ...imapExtras },
    smtp:    { host: 'smtp.example.com' },
  });
}

/* --------
 * AuthMechs
 * -------- */

describe('buildAccountBlock', () => {
  it('writes AuthMechs when the account restricts the mechanisms', () => {
    const block = buildAccountBlock(makeAccount({ authMechs: 'PLAIN' }));

    expect(block).toContain('\nAuthMechs PLAIN\n');
  });

  it('keeps AuthMechs inside the IMAPAccount block, before the store definitions', () => {
    const block = buildAccountBlock(makeAccount({ authMechs: 'LOGIN PLAIN' }));

    expect(block.indexOf('AuthMechs LOGIN PLAIN')).toBeGreaterThan(block.indexOf('IMAPAccount work'));
    expect(block.indexOf('AuthMechs LOGIN PLAIN')).toBeLessThan(block.indexOf('IMAPStore work-remote'));
  });

  it('leaves the choice to SASL when the account says nothing', () => {
    expect(buildAccountBlock(makeAccount())).not.toContain('AuthMechs');
  });

  it('never relaxes the transport, whatever the mechanisms', () => {
    const block = buildAccountBlock(makeAccount({ authMechs: 'PLAIN' }));

    expect(block).toContain('TLSType IMAPS');
    expect(block).toContain('CertificateFile /etc/ssl/cert.pem');
  });
});

/* --------
 * authMechs validation
 * -------- */

describe('imap.authMechs schema', () => {
  it.each(['PLAIN', 'LOGIN PLAIN', 'SCRAM-SHA-256', 'CRAM-MD5'])('accepts %s', (value) => {
    expect(() => makeAccount({ authMechs: value })).not.toThrow();
  });

  it('rejects a value that would inject a directive into the generated file', () => {
    // The value lands verbatim in `mbsyncrc`: a newline would start a new directive.
    expect(() => makeAccount({ authMechs: 'PLAIN\nPassCmd "evil"' })).toThrow();
  });

  it.each(['', 'plain', 'PLAIN  LOGIN', ' PLAIN', 'PLAIN;'])('rejects %j', (value) => {
    expect(() => makeAccount({ authMechs: value })).toThrow();
  });
});

/* --------
 * OAuth accounts
 * -------- */

describe('OAuth account block', () => {
  const oauthAccount = accountSchema.parse({
    id:      'office',
    label:   'Office',
    address: 'you@example.com',
    auth:    {
      type:     'oauth2',
      provider: 'microsoft',
      tenantId: '11111111-2222-3333-4444-555555555555',
      clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    },
    imap: { host: 'outlook.office365.com', user: 'you@example.com' },
  });

  const endpoint = { host: '127.0.0.1', port: 54321, password: 'one-time-password' };

  it('points mbsync at the loopback proxy, with IMAP LOGIN and the one-time password', () => {
    const block = buildAccountBlock(oauthAccount, endpoint);

    expect(block).toContain('Host 127.0.0.1\nPort 54321\nUser you@example.com\nPass one-time-password\nAuthMechs LOGIN\nTLSType None');
  });

  it('never names the real server or the Keychain in a proxied block', () => {
    const block = buildAccountBlock(oauthAccount, endpoint);

    expect(block).not.toContain('outlook.office365.com');
    expect(block).not.toContain('PassCmd');
  });

  it('refuses to write an OAuth account without a running proxy', () => {
    expect(() => buildAccountBlock(oauthAccount)).toThrow(/needs the loopback proxy/);
  });

  it('keeps a password account on the real server with TLS', () => {
    const block = buildAccountBlock(makeAccount());

    expect(block).toContain('Host imap.example.com');
    expect(block).toContain('TLSType IMAPS');
  });
});
