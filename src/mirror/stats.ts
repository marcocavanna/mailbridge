import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

import { resolveMaildirPath } from './paths.js';
import { getNotmuchConfigPath } from './sync.js';

import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const COMMAND_TIMEOUT_MS = 30_000;

const execFileAsync = promisify(execFile);

/* --------
 * Types
 * -------- */

export interface MirrorStats {
  /** Does the mirror exist on disk? */
  exists: boolean;
  path: string;
  /** Bytes used, `undefined` when it cannot be measured. */
  sizeBytes: number | undefined;
  /** Messages indexed for this account, `undefined` when notmuch is unavailable. */
  indexedMessages: number | undefined;
  unreadMessages: number | undefined;
}

/* --------
 * Helpers
 * -------- */

async function measureSize(path: string): Promise<number | undefined> {
  try {
    // `du -sk` is orders of magnitude faster than a recursive walk in Node across tens of thousands
    // of files, which is the typical size of a mirrored mailbox.
    const { stdout } = await execFileAsync('/usr/bin/du', ['-sk', path], {
      timeout:   COMMAND_TIMEOUT_MS,
      maxBuffer: 4096,
    });

    const kilobytes = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);

    return Number.isNaN(kilobytes) ? undefined : kilobytes * 1024;
  } catch {
    return undefined;
  }
}

async function countMessages(query: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('notmuch', ['count', '--output=messages', query], {
      timeout:   COMMAND_TIMEOUT_MS,
      maxBuffer: 4096,
      env:       { ...process.env, NOTMUCH_CONFIG: getNotmuchConfigPath() },
    });

    const parsed = Number.parseInt(stdout.trim(), 10);

    return Number.isNaN(parsed) ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * Mirror statistics for one account: presence, size on disk, indexed messages.
 *
 * None of these measurements is essential: when one is unavailable it stays `undefined` and the CLI
 * shows it as such, instead of failing the whole status screen.
 */
export async function readMirrorStats(account: Account): Promise<MirrorStats> {
  const path = resolveMaildirPath(account);

  // ---- Existence
  let exists = false;

  try {
    const info = await stat(path);

    exists = info.isDirectory();
  } catch {
    exists = false;
  }

  if (!exists) {
    return {
      exists:          false,
      path,
      sizeBytes:       undefined,
      indexedMessages: undefined,
      unreadMessages:  undefined,
    };
  }

  // `path:` with a trailing `**` is the only recursive form notmuch accepts: `folder:` is a boolean
  // term and ignores wildcards, returning zero without signalling anything.
  const [sizeBytes, indexedMessages, unreadMessages] = await Promise.all([
    measureSize(path),
    countMessages(`path:"${account.id}/**"`),
    countMessages(`path:"${account.id}/**" and tag:unread`),
  ]);

  return { exists, path, sizeBytes, indexedMessages, unreadMessages };
}
