import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveConfigPath } from '#config/load-accounts';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

/* --------
 * Constants
 * -------- */

/**
 * Past this age a lock is considered abandoned even if the process looks alive: it covers the case of
 * a pid recycled by the system onto an unrelated process.
 */
const STALE_AFTER_MS = 60 * 60_000;

/* --------
 * Types
 * -------- */

interface LockContent {
  pid: number;
  startedAt: string;
  /** Who took the lock: useful to tell a scheduled sync from a manual one. */
  source: string;
}

/* --------
 * Helpers
 * -------- */

function resolveLockPath(): string {
  return join(dirname(resolveConfigPath()), 'sync.lock');
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 does nothing: it only checks that the process exists.
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function readLock(path: string): Promise<LockContent | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockContent;
  } catch {
    return undefined;
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * Runs an operation holding an exclusive lock on the sync.
 *
 * It is needed because two `mbsync` runs on the same channel fight over the sync state. It becomes
 * concrete as soon as a scheduled sync exists: the agent fires on a fixed interval and has no idea
 * you are running one by hand.
 *
 * A lock whose process no longer exists is detected and removed: a crash does not leave the sync
 * blocked forever.
 */
export async function withSyncLock<T>(source: string, operation: () => Promise<T>): Promise<T> {
  const path = resolveLockPath();

  // ---- Existing lock
  const existing = await readLock(path);

  if (existing !== undefined) {
    const age = Date.now() - new Date(existing.startedAt).getTime();
    const alive = isProcessAlive(existing.pid);

    if (alive && age < STALE_AFTER_MS) {
      throw new MailbridgeError('mirror_unavailable', `Another sync is already running (pid ${existing.pid}, started by ${existing.source}).`, {
        remediation: 'Wait for it to finish, or check `mailbridge schedule status`.',
      });
    }

    logger.warn('abandoned sync lock, removing it', {
      pid: existing.pid,
      source: existing.source,
      alive,
      ageMinutes: Math.round(age / 60_000),
    });

    await rm(path, { force: true });
  }

  // ---- Acquire
  const content: LockContent = {
    pid:       process.pid,
    startedAt: new Date().toISOString(),
    source,
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(content, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

  try {
    return await operation();
  } finally {
    // ---- Cleanup: always, even if the operation throws
    await rm(path, { force: true });
  }
}
