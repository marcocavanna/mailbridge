import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { addAccount } from '#config/write-accounts';
import { isServerChange, retiredMirrorPath, switchAccountServer } from '#mirror/server-switch';
import { hasCompletedSync, readMirrorState, recordSync } from '#mirror/state';

import type { Account } from '#config/accounts.schema';

/* --------
 * Fixture
 * -------- */

let directory: string;
let mailRoot: string;

const NOW = new Date('2026-11-20T18:30:00.000Z');

const aruba: Account = accountSchema.parse({
  id:      'office',
  label:   'Office',
  address: 'someone@example.com',
  imap:    { host: 'imaps.aruba.it', user: 'someone@example.com', authMechs: 'PLAIN' },
  smtp:    { host: 'smtps.aruba.it' },
});

const microsoft: Account = accountSchema.parse({
  id:      'office',
  label:   'Office',
  address: 'someone@example.com',
  auth:    {
    type:     'oauth2',
    provider: 'microsoft',
    tenantId: '11111111-2222-3333-4444-555555555555',
    clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  },
  imap: { host: 'outlook.office365.com', user: 'someone@example.com' },
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mailbridge-switch-'));
  mailRoot = join(directory, 'Mail');
  process.env['MAILBRIDGE_CONFIG'] = join(directory, 'config', 'accounts.json');
  process.env['MAILBRIDGE_MAIL_ROOT'] = mailRoot;

  await addAccount(aruba);
  await mkdir(join(mailRoot, 'office', 'INBOX', 'cur'), { recursive: true });
  await writeFile(join(mailRoot, 'office', 'INBOX', 'cur', '1.host,U=1:2,S'), 'Subject: old\r\n\r\nold server\r\n');
  await recordSync('office', { lastSyncAt: '2026-11-19T10:00:00.000Z', lastSyncOk: true, indexedMessages: undefined });
});

afterEach(async () => {
  delete process.env['MAILBRIDGE_CONFIG'];
  delete process.env['MAILBRIDGE_MAIL_ROOT'];
  await rm(directory, { recursive: true, force: true });
});

/* --------
 * Behaviour
 * -------- */

describe('moving an account to another server', () => {
  it('recognizes a change of host, whatever the case', () => {
    expect(isServerChange(aruba, microsoft)).toBe(true);
    expect(isServerChange(aruba, { ...aruba, imap: { ...aruba.imap, host: 'IMAPS.Aruba.IT' } })).toBe(false);
  });

  it('retires the old mirror outside the mail root, naming account, server and time', () => {
    expect(retiredMirrorPath('office', 'imaps.aruba.it', NOW))
      .toBe(join(directory, 'Mail-previous', 'office-imaps.aruba.it-20261120-183000'));
  });

  it('saves the new configuration, moves the old mirror and forgets the old history', async () => {
    const { retired } = await switchAccountServer('office', aruba, microsoft, NOW);

    const config = JSON.parse(await readFile(process.env['MAILBRIDGE_CONFIG'] ?? '', 'utf8')) as { accounts: Account[] };

    expect(config.accounts[0]?.imap.host).toBe('outlook.office365.com');
    expect(await exists(join(mailRoot, 'office'))).toBe(false);
    expect(retired?.to).toBe(retiredMirrorPath('office', 'imaps.aruba.it', NOW));
    expect(await readFile(join(retired?.to ?? '', 'INBOX', 'cur', '1.host,U=1:2,S'), 'utf8')).toContain('old server');
    expect(hasCompletedSync(await readMirrorState(), 'office')).toBe(false);
  });

  it('forgets the history even when there is no mirror on disk', async () => {
    await rm(join(mailRoot, 'office'), { recursive: true });

    const { retired } = await switchAccountServer('office', aruba, microsoft, NOW);

    expect(retired).toBeUndefined();
    expect(hasCompletedSync(await readMirrorState(), 'office')).toBe(false);
  });

  it('changes nothing while a sync is running', async () => {
    await writeFile(join(directory, 'config', 'sync.lock'), JSON.stringify({
      pid:       process.pid,
      startedAt: new Date().toISOString(),
      source:    'schedule',
    }), 'utf8');

    await expect(switchAccountServer('office', aruba, microsoft, NOW)).rejects.toThrow(/already running/);

    const config = JSON.parse(await readFile(process.env['MAILBRIDGE_CONFIG'] ?? '', 'utf8')) as { accounts: Account[] };

    expect(config.accounts[0]?.imap.host).toBe('imaps.aruba.it');
    expect(await exists(join(mailRoot, 'office', 'INBOX'))).toBe(true);
    expect(hasCompletedSync(await readMirrorState(), 'office')).toBe(true);
  });

  it('changes nothing when the destination already exists', async () => {
    await mkdir(retiredMirrorPath('office', 'imaps.aruba.it', NOW), { recursive: true });

    await expect(switchAccountServer('office', aruba, microsoft, NOW)).rejects.toThrow(/already exists/);

    const config = JSON.parse(await readFile(process.env['MAILBRIDGE_CONFIG'] ?? '', 'utf8')) as { accounts: Account[] };

    expect(config.accounts[0]?.imap.host).toBe('imaps.aruba.it');
    expect(await exists(join(mailRoot, 'office', 'INBOX'))).toBe(true);
  });
});
