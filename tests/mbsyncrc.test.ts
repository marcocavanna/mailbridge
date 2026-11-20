import { describe, expect, it } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { buildAccountBlock, buildTunnelCommand } from '#mirror/mbsyncrc';

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

  it('runs the tunnel with absolute paths, and holds no host, user or password', () => {
    const block = buildAccountBlock(oauthAccount);
    const tunnel = /^Tunnel "'(.+)' '(.+)' imap-tunnel 'office'"$/m.exec(block);

    expect(tunnel?.[1]).toBe(process.execPath);
    expect(tunnel?.[2]).toMatch(/\/cli\/main\.js$/);
    expect(block).toContain('TLSType None');
    expect(block).not.toMatch(/^(Host|User|Pass|PassCmd|AuthMechs) /m);
  });

  it('refuses a path that would need escaping in the shell command', () => {
    expect(() => buildTunnelCommand('office', "/opt/it's/node", '/x/main.js')).toThrow(/quotes or line breaks/);
    expect(() => buildTunnelCommand('office', '/opt/node', '/x/main.js\n; rm -rf ~')).toThrow(/quotes or line breaks/);
  });

  it('keeps a password account on the real server with TLS', () => {
    const block = buildAccountBlock(makeAccount());

    expect(block).toContain('Host imap.example.com');
    expect(block).toContain('TLSType IMAPS');
  });
});
