import { createHash, randomBytes } from 'node:crypto';

/* --------
 * Types
 * -------- */

export interface PkcePair {
  /** Kept by this process and sent only to the token endpoint. */
  verifier: string;
  /** Sent in the authorization request, where the browser and its history can see it. */
  challenge: string;
}

/* --------
 * Implementation
 * -------- */

/**
 * The S256 challenge of a verifier (RFC 7636 §4.2): base64url of its SHA-256, without padding.
 */
export function deriveChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * A fresh PKCE pair. 32 random bytes encode to a 43-character verifier, the minimum RFC 7636 allows
 * and the length its own example uses; base64url is a subset of the unreserved characters it requires.
 */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');

  return { verifier, challenge: deriveChallenge(verifier) };
}

/**
 * An opaque value that ties the redirect to the request this process made. A callback carrying any
 * other value did not come from our authorization request and is refused.
 */
export function createState(): string {
  return randomBytes(16).toString('base64url');
}
