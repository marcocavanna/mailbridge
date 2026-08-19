import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareVersions,
  isUpdateCheckEnabled,
  readPendingNotice,
  readUpdateState,
  resolveUpdateCommand,
  suppressUpdateNotices,
} from '#shared/update';

/* --------
 * compareVersions
 * -------- */

describe('compareVersions', () => {
  it('orders by major, minor and patch', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.9', '1.0.10')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });

  /*
   * The trap a string comparison falls into: '1.10.0' < '1.2.0' alphabetically, which would tell users on
   * 1.10.0 to downgrade.
   */
  it('does not compare version numbers as strings', () => {
    expect(compareVersions('1.10.0', '1.2.0')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('tolerates a v prefix', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });

  it('ranks a release above its own pre-releases', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
  });

  it('orders pre-releases among themselves', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
  });

  /*
   * `0.0.0` is what the version reader falls back to when the manifest cannot be read. It has to sort below
   * any real release, so that case shows as outdated rather than claiming to be current.
   */
  it('sorts the fallback version below any release', () => {
    expect(compareVersions('0.0.0', '0.1.0')).toBeLessThan(0);
  });
});

/* --------
 * isUpdateCheckEnabled
 * -------- */

describe('isUpdateCheckEnabled', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    delete process.env['MAILBRIDGE_NO_UPDATE_CHECK'];
    delete process.env['NO_UPDATE_NOTIFIER'];
    delete process.env['CI'];
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('is on by default', () => {
    expect(isUpdateCheckEnabled()).toBe(true);
  });

  it('honours its own opt-out', () => {
    process.env['MAILBRIDGE_NO_UPDATE_CHECK'] = '1';

    expect(isUpdateCheckEnabled()).toBe(false);
  });

  /*
   * The conventional variable is honoured too: somebody who has already told every tool on their machine to
   * stop doing this should not have to tell this one separately.
   */
  it('honours the conventional NO_UPDATE_NOTIFIER', () => {
    process.env['NO_UPDATE_NOTIFIER'] = 'true';

    expect(isUpdateCheckEnabled()).toBe(false);
  });

  it('stays quiet in CI, where nobody reads an upgrade hint', () => {
    process.env['CI'] = 'true';

    expect(isUpdateCheckEnabled()).toBe(false);
  });

  it('treats an empty or zero value as not opting out', () => {
    process.env['MAILBRIDGE_NO_UPDATE_CHECK'] = '';

    expect(isUpdateCheckEnabled()).toBe(true);

    process.env['MAILBRIDGE_NO_UPDATE_CHECK'] = '0';

    expect(isUpdateCheckEnabled()).toBe(true);
  });
});

/* --------
 * Suppression and notices
 * -------- */

describe('notices and suppression', () => {
  const saved = { ...process.env };
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mailbridge-update-'));
    process.env['MAILBRIDGE_CONFIG'] = join(directory, 'accounts.json');
    delete process.env['MAILBRIDGE_NO_UPDATE_CHECK'];
    delete process.env['NO_UPDATE_NOTIFIER'];
    delete process.env['CI'];
  });

  afterEach(() => {
    process.env = { ...saved };
    rmSync(directory, { recursive: true, force: true });
  });

  it('reports nothing with a cold cache, instead of guessing', () => {
    expect(readPendingNotice()).toBeUndefined();
  });

  it('stores and clears a suppression window', () => {
    const until = suppressUpdateNotices(48);

    expect(until).toBeDefined();
    expect(readUpdateState()?.suppressedUntil).toBe(until);

    expect(suppressUpdateNotices(0)).toBeUndefined();
    expect(readUpdateState()?.suppressedUntil).toBeUndefined();
  });

  /*
   * The suppression has to hold for the MCP handshake too, which reads the same state synchronously. If it
   * leaked there, silencing reminders in one place would keep announcing the update in another.
   */
  it('honours a suppression window when reading the pending notice', () => {
    suppressUpdateNotices(48);

    expect(readPendingNotice()).toBeUndefined();
  });

  it('tells a source checkout to pull rather than to npm install', () => {
    expect(resolveUpdateCommand('source')).toContain('git pull');
    expect(resolveUpdateCommand('source')).not.toContain('npm install -g');
    expect(resolveUpdateCommand('npm-global')).toContain('npm install -g mailbridge');
  });
});
