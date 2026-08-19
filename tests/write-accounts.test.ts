import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { addAccount, readConfigOrEmpty, removeAccount, updateAccount } from '#config/write-accounts';

import type { Account } from '#config/accounts.schema';

/* --------
 * Fixture
 * -------- */

let directory: string;

function buildAccount(id: string): Account {
  return accountSchema.parse({
    id,
    label:   `Account ${id}`,
    address: `${id}@example.com`,
    imap:    { host: 'imap.example.com', user: `${id}@example.com` },
    smtp:    { host: 'smtp.example.com' },
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mailbridge-test-'));
  process.env['MAILBRIDGE_CONFIG'] = join(directory, 'accounts.json');
});

afterEach(async () => {
  delete process.env['MAILBRIDGE_CONFIG'];
  await rm(directory, { recursive: true, force: true });
});

/* --------
 * Reading
 * -------- */

describe('readConfigOrEmpty', () => {
  it('returns an empty configuration when the file does not exist', async () => {
    await expect(readConfigOrEmpty()).resolves.toEqual({ version: 1, accounts: [] });
  });

  it('does not silence a malformed configuration: that has to be reported, not ignored', async () => {
    await writeFile(process.env['MAILBRIDGE_CONFIG'] ?? '', '{"version":1,"accounts":[{"id":"X!"}]}', 'utf8');

    await expect(readConfigOrEmpty()).rejects.toThrow(/schema/i);
  });
});

/* --------
 * Writing
 * -------- */

describe('account lifecycle', () => {
  it('adds and reads back', async () => {
    await addAccount(buildAccount('one'));

    const config = await readConfigOrEmpty();

    expect(config.accounts.map((entry) => entry.id)).toEqual(['one']);
  });

  it('rejects a duplicate id instead of silently overwriting', async () => {
    await addAccount(buildAccount('one'));

    await expect(addAccount(buildAccount('one'))).rejects.toThrow(/already exists/);
  });

  it('keeps the position in the list when updating', async () => {
    await addAccount(buildAccount('one'));
    await addAccount(buildAccount('two'));
    await addAccount(buildAccount('three'));

    await updateAccount('two', { ...buildAccount('two'), label: 'Renamed' });

    const config = await readConfigOrEmpty();

    expect(config.accounts.map((entry) => entry.id)).toEqual(['one', 'two', 'three']);
    expect(config.accounts[1]?.label).toBe('Renamed');
  });

  it('allows renaming the id', async () => {
    await addAccount(buildAccount('one'));
    await updateAccount('one', buildAccount('first'));

    const config = await readConfigOrEmpty();

    expect(config.accounts.map((entry) => entry.id)).toEqual(['first']);
  });

  it('rejects a rename onto an id already in use', async () => {
    await addAccount(buildAccount('one'));
    await addAccount(buildAccount('two'));

    await expect(updateAccount('one', buildAccount('two'))).rejects.toThrow(/already in use/);
  });

  it('refuses to update an account that does not exist', async () => {
    await expect(updateAccount('ghost', buildAccount('ghost'))).rejects.toThrow(/No account/);
  });

  /*
   * Regression: the schema demanded at least one account, so removing the last one failed validation on
   * write. An empty configuration is a legitimate state.
   */
  it('removes even the last account, leaving a valid empty configuration', async () => {
    await addAccount(buildAccount('only'));

    const { removed } = await removeAccount('only');

    expect(removed.id).toBe('only');
    await expect(readConfigOrEmpty()).resolves.toEqual({ version: 1, accounts: [] });
  });

  it('refuses to remove an account that does not exist', async () => {
    await expect(removeAccount('ghost')).rejects.toThrow(/No account/);
  });
});

/* --------
 * Secrets
 * -------- */

describe('configuration safety', () => {
  it('never writes a password to the file, not even one smuggled into the object', async () => {
    const account = { ...buildAccount('one'), password: 'should-not-get-through' } as unknown as Account;

    await addAccount(account);

    const raw = await readFile(process.env['MAILBRIDGE_CONFIG'] ?? '', 'utf8');

    expect(raw).not.toContain('should-not-get-through');
    expect(raw).not.toMatch(/password/i);
  });
});
