import { describe, expect, it } from 'vitest';

import { redact, registerSecret } from '#shared/logger';

/* --------
 * Redaction
 * -------- */

describe('secret redaction', () => {
  it('hides a registered secret inside a string', () => {
    registerSecret('sup3r-s3cret');

    expect(redact('login with sup3r-s3cret failed')).toBe('login with [redacted] failed');
  });

  it('hides it when nested in an object too', () => {
    registerSecret('another-password');

    const output = redact({ auth: { pass: 'another-password' }, host: 'imap.x.it' });

    expect(output).toEqual({ auth: { pass: '[redacted]' }, host: 'imap.x.it' });
  });

  it('hides it inside an array', () => {
    registerSecret('token-xyz1');

    expect(redact(['a', 'token-xyz1'])).toEqual(['a', '[redacted]']);
  });

  it('hides it in an error message', () => {
    registerSecret('pw-in-the-error');

    expect(redact(new Error('auth failed for pw-in-the-error'))).toBe('auth failed for [redacted]');
  });

  it('does not register very short strings, which would make logs unreadable', () => {
    registerSecret('ab');

    expect(redact('ab abacus')).toBe('ab abacus');
  });

  it('leaves non-string values untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
  });
});
