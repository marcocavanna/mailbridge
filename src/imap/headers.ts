import { withMailbox } from './connection.js';

import { MailbridgeError } from '#shared/errors';

import type { Account } from '#config/accounts.schema';

/* --------
 * Types
 * -------- */

/** Header name in lowercase → its values. A header can legitimately appear more than once. */
export type HeaderMap = Record<string, string[]>;

/* --------
 * Helpers
 * -------- */

/**
 * Parses a raw header block into a map.
 *
 * Two details that a naive `split(':')` gets wrong: a header can be **folded** across several lines
 * (continuation lines start with whitespace, RFC 5322 §2.2.3), and the same name can appear repeatedly
 * — `Received` always does, and `List-Unsubscribe` sometimes does.
 */
export function parseHeaderBlock(raw: string): HeaderMap {
  const headers: HeaderMap = {};
  const lines = raw.split(/\r?\n/);

  let currentName: string | undefined;
  let currentValue = '';

  const flush = (): void => {
    if (currentName === undefined) {
      return;
    }

    headers[currentName] = [...(headers[currentName] ?? []), currentValue.trim()];
    currentName = undefined;
    currentValue = '';
  };

  for (const line of lines) {
    if (line.length === 0) {
      break;
    }

    // ---- Folded continuation
    if (/^[ \t]/.test(line)) {
      if (currentName !== undefined) {
        currentValue += ` ${line.trim()}`;
      }

      continue;
    }

    flush();

    const separator = line.indexOf(':');

    if (separator === -1) {
      continue;
    }

    currentName = line.slice(0, separator).trim().toLowerCase();
    currentValue = line.slice(separator + 1).trim();
  }

  flush();

  return headers;
}

/* --------
 * Implementation
 * -------- */

/**
 * Reads a message's headers, all of them or a named subset.
 *
 * Headers are content written by third parties, exactly like a body: an address in `From` is a claim,
 * not proof, and a URL in `List-Unsubscribe` is a link somebody else chose. See
 * `.claude/rules/security.md` §2.
 */
export async function getHeaders(
  account: Account,
  folder: string,
  uid: number,
  names?: readonly string[],
): Promise<HeaderMap> {
  return withMailbox(account, folder, async (client) => {
    const entry = await client.fetchOne(
      String(uid),
      { uid: true, headers: names === undefined ? true : [...names] },
      { uid: true },
    );

    if (entry === false || entry.headers === undefined) {
      throw new MailbridgeError('message_not_found', `Cannot read the headers of uid ${uid} in "${folder}".`, {
        remediation: 'Re-read the folder: uids change when a message is moved.',
      });
    }

    return parseHeaderBlock(entry.headers.toString('utf8'));
  });
}
