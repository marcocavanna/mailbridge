import type { HeaderMap } from './headers.js';

/* --------
 * Types
 * -------- */

export interface UnsubscribeTarget {
  kind: 'http' | 'mailto';
  /** The URI exactly as the sender wrote it. Untrusted: it is reported, never opened. */
  value: string;
}

/* --------
 * Implementation
 * -------- */

/**
 * Parses a `List-Unsubscribe` value: a comma-separated list of URIs in angle brackets, per RFC 2369.
 *
 * Values outside brackets are tolerated because they occur in the wild, and anything that is neither
 * http(s) nor mailto is dropped rather than guessed at.
 */
export function parseUnsubscribeHeader(value: string): UnsubscribeTarget[] {
  const targets: UnsubscribeTarget[] = [];
  const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((match) => match[1] ?? '');
  const candidates = bracketed.length > 0 ? bracketed : value.split(',');

  for (const candidate of candidates) {
    const trimmed = candidate.trim();

    if (/^https?:\/\//i.test(trimmed)) {
      targets.push({ kind: 'http', value: trimmed });
      continue;
    }

    if (/^mailto:/i.test(trimmed)) {
      targets.push({ kind: 'mailto', value: trimmed });
    }
  }

  return targets;
}

/**
 * Is this bulk mail? Presence of any `List-*` header, or an explicit bulk `Precedence`.
 */
export function isBulkMail(headers: HeaderMap): boolean {
  if (
    headers['list-unsubscribe'] !== undefined
    || headers['list-id'] !== undefined
    || headers['list-post'] !== undefined
  ) {
    return true;
  }

  const precedence = headers['precedence']?.[0]?.toLowerCase();

  return precedence === 'bulk' || precedence === 'list' || precedence === 'junk';
}

/**
 * Normalizes a `List-Id` for grouping. The declared form is `Friendly Name <list.id.example.com>`, and
 * the part in brackets is the stable identifier.
 */
export function normalizeListId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const bracketed = /<([^>]+)>/.exec(value);
  const normalized = (bracketed?.[1] ?? value).trim().toLowerCase();

  return normalized.length === 0 ? undefined : normalized;
}
