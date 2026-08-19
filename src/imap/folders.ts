import { withImap } from './connection.js';

import { MailbridgeError } from '#shared/errors';

import type { Account, SpecialFolder } from '#config/accounts.schema';
import type { Folder } from '#shared/mail.types';

/* --------
 * Constants
 * -------- */

/** SPECIAL-USE flags (RFC 6154) mapped to our special folder vocabulary. */
const SPECIAL_USE_MAP: Record<string, SpecialFolder> = {
  '\\Archive': 'archive',
  '\\Drafts':  'drafts',
  '\\Junk':    'junk',
  '\\Sent':    'sent',
  '\\Trash':   'trash',
};

/**
 * Last resort when the server announces no SPECIAL-USE: folder names observed in practice, in order of
 * preference. Matched case-insensitively against the last path segment.
 *
 * These are **data, not user-facing text**: many providers localize folder names, so the list has to
 * carry those spellings to recognize them. Add a language by extending the arrays — never by
 * translating them.
 */
const NAME_FALLBACK: Record<SpecialFolder, string[]> = {
  inbox: ['inbox', 'posta in arrivo', 'boîte de réception', 'eingang', 'bandeja de entrada'],
  sent: [
    'sent', 'sent items', 'sent messages',
    'posta inviata', 'inviata',
    'envoyés', 'gesendet', 'enviados',
  ],
  drafts:  ['drafts', 'bozze', 'brouillons', 'entwürfe', 'borradores'],
  archive: ['archive', 'all mail', 'archivio', 'archives', 'archiv', 'archivados'],
  trash: [
    'trash', 'deleted items',
    'cestino', 'eliminata',
    'corbeille', 'gelöscht', 'papelera',
  ],
  junk: [
    'junk', 'spam',
    'posta indesiderata', 'indesiderata',
    'courrier indésirable', 'werbung', 'correo no deseado',
  ],
};

/* --------
 * Helpers
 * -------- */

function lastSegment(path: string, delimiter: string): string {
  if (delimiter.length === 0) {
    return path;
  }

  const parts = path.split(delimiter);

  return parts[parts.length - 1] ?? path;
}

/* --------
 * Implementation
 * -------- */

/**
 * Lists the account's folders, with the special role already resolved where the server declares it.
 */
export async function listFolders(account: Account): Promise<Folder[]> {
  return withImap(account, async (client) => {
    const entries = await client.list();

    return entries.map((entry) => {
      const delimiter = entry.delimiter ?? '/';
      const name = lastSegment(entry.path, delimiter);

      // ---- Result mapping
      const declared = entry.specialUse === undefined ? undefined : SPECIAL_USE_MAP[entry.specialUse];
      const specialUse = entry.path.toLowerCase() === 'inbox' ? 'inbox' : declared;

      return {
        path:       entry.path,
        name,
        delimiter,
        specialUse,
        subscribed: entry.subscribed === true,
      };
    });
  });
}

/**
 * Resolves the path of a special folder in three steps: explicit override in the configuration,
 * SPECIAL-USE flag announced by the server, then known names.
 *
 * The override always wins: it is the only remedy for servers that announce nothing and use names
 * outside any convention.
 */
export async function resolveSpecialFolder(account: Account, special: SpecialFolder): Promise<string> {
  // ---- Configured override
  const configured = account.folders[special];

  if (configured !== undefined) {
    return configured;
  }

  if (special === 'inbox') {
    return 'INBOX';
  }

  const folders = await listFolders(account);

  // ---- Announced special use
  const announced = folders.find((folder) => folder.specialUse === special);

  if (announced !== undefined) {
    return announced.path;
  }

  // ---- Known names
  const candidates = NAME_FALLBACK[special];
  const guessed = folders.find((folder) => candidates.includes(folder.name.toLowerCase()));

  if (guessed !== undefined) {
    return guessed.path;
  }

  throw new MailbridgeError('folder_not_found', `Cannot locate the "${special}" folder on "${account.id}".`, {
    remediation: `Declare the exact path in accounts.json, under folders.${special}.`,
  });
}
