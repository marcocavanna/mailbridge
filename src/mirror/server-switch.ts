import { mkdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { withSyncLock } from './lock.js';
import { resolveMailRoot, resolveMaildirPath } from './paths.js';
import { forgetSync } from './state.js';

import { updateAccount } from '#config/write-accounts';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';

/* --------
 * Types
 * -------- */

export interface RetiredMirror {
  from: string;
  to: string;
}

export interface ServerSwitchResult {
  /** Where the old mirror went, when there was one on disk. */
  retired: RetiredMirror | undefined;
}

/* --------
 * Helpers
 * -------- */

/**
 * Whether an edit moves the account to another mail server. The mirror belongs to a server: its folders,
 * its uids and mbsync's sync state are that server's, and none of it carries over.
 */
export function isServerChange(previous: Account, updated: Account): boolean {
  return previous.imap.host.trim().toLowerCase() !== updated.imap.host.trim().toLowerCase();
}

/**
 * Where an old mirror goes: outside the mail root, so the index forgets it at the next sync and nothing
 * answers twice, under a name that says which account and which server it held and when it was retired.
 */
export function retiredMirrorPath(accountId: string, previousHost: string, now: Date = new Date()): string {
  const host = previousHost.trim().toLowerCase().replace(/[^a-z0-9.-]/g, '_');
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');

  return join(dirname(resolveMailRoot()), `${basename(resolveMailRoot())}-previous`, `${accountId}-${host}-${stamp}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * Saves an edit that moves an account to another server, and starts its mirror over.
 *
 * Three things, under the sync lock so no sync can start halfway, scheduled or manual:
 *
 * 1. the new configuration is written;
 * 2. the old mirror, if any, is **moved** out of the mail root, never deleted: it is the only local
 *    copy of the old server, and its fate is the user's decision;
 * 3. the account's sync history is forgotten, so search treats the new, empty mirror as what it is and
 *    goes to the server until the first sync completes.
 *
 * Done any other way, the scheduled sync can run between the steps: with the old configuration it
 * downloads the old server again into the path just emptied, with the new one it mixes two servers in
 * the same Maildir, and with the old history search trusts a mirror that is still filling up.
 */
export async function switchAccountServer(
  accountId: string,
  previous: Account,
  updated: Account,
  now: Date = new Date(),
): Promise<ServerSwitchResult> {
  return withSyncLock('cli', async () => {
    // ---- Validation, before anything is written
    const from = resolveMaildirPath(previous);
    const to = retiredMirrorPath(previous.id, previous.imap.host, now);
    const hasOldMirror = await exists(from);

    if (hasOldMirror && (await exists(to))) {
      throw new MailbridgeError('mirror_unavailable', `Cannot move the old mirror: ${to} already exists.`, {
        remediation: 'Move or rename that directory, then edit the account again. Nothing was changed.',
      });
    }

    // ---- Configuration
    await updateAccount(accountId, updated);

    // ---- Old mirror out of the way
    let retired: RetiredMirror | undefined;

    if (hasOldMirror) {
      await mkdir(dirname(to), { recursive: true });

      try {
        await rename(from, to);
      } catch (cause) {
        throw new MailbridgeError('mirror_unavailable', `Could not move the old mirror from ${from} to ${to}.`, {
          remediation: 'The configuration is already saved. Move the directory by hand before the next sync, and keep the mirror off until then.',
          cause,
        });
      }

      retired = { from, to };
      logger.info('old mirror moved out of the mail root', { accountId: updated.id, from, to });
    }

    // ---- History
    await forgetSync(previous.id);

    if (updated.id !== previous.id) {
      await forgetSync(updated.id);
    }

    return { retired };
  });
}
