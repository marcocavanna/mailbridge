import { askConfirm, prompts } from './prompt-helpers.js';
import { runSyncWithFeedback } from './sync-actions.js';
import { colors, formatBytes } from './ui.js';

import { resolveMaildirPath } from '#mirror/paths';
import { switchAccountServer } from '#mirror/server-switch';
import { readMirrorStats } from '#mirror/stats';

import type { Account } from '#config/accounts.schema';

/* --------
 * Implementation
 * -------- */

/**
 * Saves an edit that moves the account to another server, after saying what happens to the old mirror.
 *
 * Returns `false` when the user declines: nothing has been written. The old mirror is moved, never
 * deleted, and the message says where, because it is the only local copy of the old server.
 */
export async function confirmAndSwitchServer(target: string, previous: Account, updated: Account): Promise<boolean> {
  // ---- What is about to happen
  // Measured on disk, whatever the configuration says: a mirror switched off still has its files, and
  // they are moved all the same.
  const oldPath = resolveMaildirPath(previous);
  const stats = await readMirrorStats(previous);
  const hasOldMirror = stats.exists;

  prompts.log.warn([
    `The server changes from ${colors.bold(previous.imap.host)} to ${colors.bold(updated.imap.host)}.`,
    hasOldMirror
      ? `The local mirror in ${oldPath} (${formatBytes(stats.sizeBytes)}) holds the old server's mail: it is moved out of the mail folder, not deleted, and the new mirror starts empty.`
      : 'There is no local mirror on disk to move.',
    'Until the first sync on the new server completes, search on this account goes to the server.',
  ].join('\n  '));

  if (!(await askConfirm('Proceed?', true))) {
    prompts.log.info('Cancelled: nothing was changed.');

    return false;
  }

  // ---- Save, move, forget: under the sync lock
  const { retired } = await switchAccountServer(target, previous, updated);

  if (retired !== undefined) {
    prompts.log.success(`Old mirror moved to ${colors.bold(retired.to)}. Delete it yourself once you no longer need it.`);
  }

  return true;
}

/**
 * Offers the first sync of a mirror that starts empty. It can take a while, so it is a question: the
 * scheduled sync, or `mailbridge sync <id>`, resumes it if it stops at the time limit.
 */
export async function offerFirstSync(account: Account): Promise<void> {
  if (!account.mirror.enabled) {
    return;
  }

  const shouldSync = await askConfirm('Download the mailbox into the local mirror now? The first sync takes a while.', true);

  if (!shouldSync) {
    prompts.log.info(`Run \`mailbridge sync ${account.id}\` when you want it; the scheduled sync, if enabled, will do it too.`);

    return;
  }

  await runSyncWithFeedback([account.id]);

  prompts.log.info(`If the sync stopped at the 15-minute limit, run \`mailbridge sync ${account.id}\` again: it resumes where it stopped.`);
}
