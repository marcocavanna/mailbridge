import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withSyncLock } from '#mirror/lock';

/* --------
 * Fixture
 * -------- */

let directory: string;
let lockPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mailbridge-lock-'));
  process.env['MAILBRIDGE_CONFIG'] = join(directory, 'accounts.json');
  lockPath = join(directory, 'sync.lock');
});

afterEach(async () => {
  delete process.env['MAILBRIDGE_CONFIG'];
  await rm(directory, { recursive: true, force: true });
});

/* --------
 * Locking
 * -------- */

describe('withSyncLock', () => {
  it('runs the operation and releases the lock', async () => {
    const result = await withSyncLock('test', async () => 'done');

    expect(result).toBe('done');
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow();
  });

  it('releases the lock even when the operation throws', async () => {
    await expect(withSyncLock('test', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    // A lock held after an error would block every later sync.
    await expect(readFile(lockPath, 'utf8')).rejects.toThrow();
  });

  it('refuses a second sync while the first is running', async () => {
    let release: (() => void) | undefined;

    const first = withSyncLock('first', async () => new Promise<void>((resolve) => {
      release = resolve;
    }));

    // Wait for the lock to be written.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(withSyncLock('second', async () => undefined)).rejects.toThrow(/already running/);

    release?.();
    await first;
  });

  it('records who took the lock, to tell a scheduled run from a manual one', async () => {
    let content = '';

    await withSyncLock('schedule', async () => {
      content = await readFile(lockPath, 'utf8');
    });

    expect(JSON.parse(content)).toMatchObject({ source: 'schedule', pid: process.pid });
  });

  /*
   * A crash leaves the lock file on disk. Without detection the sync would stay blocked forever, and the
   * only way out would be deleting a file by hand.
   */
  it('removes a lock whose process no longer exists', async () => {
    await writeFile(lockPath, JSON.stringify({
      pid:       999_999,
      startedAt: new Date().toISOString(),
      source:    'dead-process',
    }), 'utf8');

    await expect(withSyncLock('new', async () => 'restarted')).resolves.toBe('restarted');
  });

  it('removes a lock that is too old even if the pid looks alive, for the recycled-pid case', async () => {
    await writeFile(lockPath, JSON.stringify({
      pid:       process.pid,
      startedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      source:    'ancient',
    }), 'utf8');

    await expect(withSyncLock('new', async () => 'restarted')).resolves.toBe('restarted');
  });
});
