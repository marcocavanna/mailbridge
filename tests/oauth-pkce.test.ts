import { describe, expect, it } from 'vitest';

import { createPkcePair, createState, deriveChallenge } from '#oauth/pkce';

/* --------
 * PKCE
 * -------- */

describe('PKCE', () => {
  it('derives the S256 challenge of the RFC 7636 example (Appendix B)', () => {
    expect(deriveChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'))
      .toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generates a verifier inside the length and alphabet RFC 7636 allows', () => {
    const { verifier, challenge } = createPkcePair();

    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(challenge).toBe(deriveChallenge(verifier));
  });

  it('never repeats a verifier or a state', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
    expect(createState()).not.toBe(createState());
  });
});
