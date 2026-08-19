import addressparser from 'nodemailer/lib/addressparser/index.js';

import type { MailAddress } from './mail.types.js';

/* --------
 * Implementation
 * -------- */

/**
 * Normalizes a list of addresses whatever its origin — IMAP envelope, mailparser output, a parsed
 * header — flattening groups (`name: a@x, b@y;`) and dropping entries without an address.
 *
 * Takes `unknown` on purpose: the three upstream libraries type the same thing in three
 * incompatible ways, and the narrowing belongs in one place, here.
 */
export function mapAddresses(entries: readonly unknown[] | undefined): MailAddress[] {
  if (entries === undefined) {
    return [];
  }

  const collected: MailAddress[] = [];

  const visit = (list: readonly unknown[]): void => {
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') {
        continue;
      }

      const candidate = entry as { name?: unknown; address?: unknown; group?: unknown };

      // ---- Groups
      if (Array.isArray(candidate.group)) {
        visit(candidate.group);
        continue;
      }

      if (typeof candidate.address !== 'string' || candidate.address.length === 0) {
        continue;
      }

      const name = typeof candidate.name === 'string' && candidate.name.length > 0 ? candidate.name : undefined;

      collected.push({ name, address: candidate.address });
    }
  };

  visit(entries);

  return collected;
}

/**
 * Normalizes a raw address header (`"Mario Rossi" <m@x.it>, other@y.it`).
 */
export function parseAddressHeader(header: string | undefined): MailAddress[] {
  if (header === undefined || header.length === 0) {
    return [];
  }

  return mapAddresses(addressparser(header));
}
