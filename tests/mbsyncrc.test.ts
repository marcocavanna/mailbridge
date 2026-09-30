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
