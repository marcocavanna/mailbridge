import { describe, expect, it } from 'vitest';

import { parseCallback } from '#oauth/login';

/* --------
 * Redirect parsing
 * -------- */

describe('sign-in redirect', () => {
  it('returns the code when the state matches', () => {
    expect(parseCallback('/?code=abc&state=s1', 's1')).toEqual({ kind: 'code', code: 'abc' });
  });

  it('refuses a code carrying a different state: it did not come from our request', () => {
    const outcome = parseCallback('/?code=abc&state=forged', 's1');

    expect(outcome.kind).toBe('error');
  });

  it('refuses a code with no state at all', () => {
    expect(parseCallback('/?code=abc', 's1').kind).toBe('error');
  });

  it('maps an error redirect, keeping only the first line of the description', () => {
    const outcome = parseCallback(
      `/?error=access_denied&error_description=${encodeURIComponent('AADSTS65004: User declined.\nTrace ID: x')}&state=s1`,
      's1',
    );

    expect(outcome.kind).toBe('error');

    if (outcome.kind === 'error') {
      expect(outcome.error.message).toContain('AADSTS65004');
      expect(outcome.error.message).not.toContain('Trace ID');
    }
  });

  it('points a consent error at the administrator', () => {
    const outcome = parseCallback('/?error=consent_required&state=s1', 's1');

    expect(outcome.kind === 'error' && outcome.error.toAgentMessage()).toMatch(/administrator/);
  });

  it('ignores requests that are not the redirect, such as the favicon', () => {
    expect(parseCallback('/favicon.ico', 's1')).toEqual({ kind: 'ignored' });
    expect(parseCallback('/', 's1')).toEqual({ kind: 'ignored' });
  });
});
