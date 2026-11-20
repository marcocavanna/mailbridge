import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasCompletedSync, readMirrorState, recordSync } from '#mirror/state';

/* --------
 * Fixture
 * -------- */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mailbridge-state-'));
  process.env['MAILBRIDGE_CONFIG'] = join(directory, 'accounts.json');
});

afterEach(async () => {
  delete process.env['MAILBRIDGE_CONFIG'];
  await rm(directory, { recursive: true, force: true });
});

const failed = (at: string) => ({ lastSyncAt: at, lastSyncOk: false, indexedMessages: undefined });
const succeeded = (at: string) => ({ lastSyncAt: at, lastSyncOk: true, indexedMessages: undefined });

/* --------
 * Behaviour
 * -------- */

describe('completed sync', () => {
  it('does not count a mirror whose only run failed: it may be half filled', async () => {
    await recordSync('office', failed('2026-11-20T10:00:00.000Z'));

    expect(hasCompletedSync(await readMirrorState(), 'office')).toBe(false);
  });

  it('keeps the last success across a later failure', async () => {
    await recordSync('office', succeeded('2026-11-20T10:00:00.000Z'));
    await recordSync('office', failed('2026-11-20T11:00:00.000Z'));

    const state = await readMirrorState();

    expect(state.accounts['office']?.lastOkAt).toBe('2026-11-20T10:00:00.000Z');
    expect(hasCompletedSync(state, 'office')).toBe(true);
  });

  it('reads an older state file, written before lastOkAt existed, by its outcome', () => {
    const legacy = { version: 1 as const, accounts: { home: succeeded('2026-11-01T10:00:00.000Z') } };

    expect(hasCompletedSync(legacy, 'home')).toBe(true);
    expect(hasCompletedSync(legacy, 'nobody')).toBe(false);
  });
});
