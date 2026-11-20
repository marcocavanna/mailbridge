import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountsConfigSchema } from '#config/accounts.schema';
import { readMirrorState } from '#mirror/state';
import { executeSearch } from '#search/execute';
import { searchWithImap } from '#search/imap-search';
import { isNotmuchAvailable } from '#search/notmuch-exec';
import { searchWithNotmuch } from '#search/notmuch';

/* --------
 * Mocks
 * -------- */

// The engines are the boundary: what is under test is which account goes to which, and what the
// result says about it.
vi.mock('#search/imap-search', () => ({
  searchWithImap: vi.fn(async (account: { id: string }, criteria: { folder?: string }) => ({
    hits:     [{ accountId: account.id, folder: criteria.folder ?? 'INBOX', date: '2026-11-20T10:00:00.000Z' }],
    query:    '{}',
    folders:  criteria.folder === undefined ? ['INBOX', 'Archivio', 'Posta inviata'] : [criteria.folder],
    failures: [],
  })),
}));

vi.mock('#search/notmuch', () => ({
  searchWithNotmuch: vi.fn(async () => ({
    hits:  [{ accountId: 'home', folder: 'INBOX', date: '2026-11-20T11:00:00.000Z' }],
    query: 'path:"home/**"',
  })),
}));

vi.mock('#search/notmuch-exec', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#search/notmuch-exec')>()),
  isNotmuchAvailable: vi.fn(),
}));

vi.mock('#mirror/state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#mirror/state')>()),
  readMirrorState: vi.fn(),
}));

vi.mock('#mirror/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#mirror/paths')>()),
  resolveMirrorFolder: vi.fn(async (_account: unknown, folder: string) => (folder === 'Nowhere' ? undefined : folder)),
}));

/* --------
 * Fixture
 * -------- */

function account(id: string, mirrored: boolean): Record<string, unknown> {
  return {
    id,
    label:   id,
    address: `${id}@example.com`,
    imap:    { host: 'imap.example.com', user: `${id}@example.com` },
    mirror:  { enabled: mirrored },
  };
}

const config = accountsConfigSchema.parse({
  version:  1,
  accounts: [account('home', true), account('office', false)],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isNotmuchAvailable).mockResolvedValue(true);
  vi.mocked(readMirrorState).mockResolvedValue({
    version:  1,
    accounts: { home: { lastSyncAt: new Date().toISOString(), lastSyncOk: true, indexedMessages: undefined } },
  });
});

/* --------
 * Behaviour
 * -------- */

describe('engine choice per account', () => {
  it('keeps the index for the mirrored account when another account has no mirror', async () => {
    const outcome = await executeSearch(config, { text: 'invoice', limit: 20 });

    expect(outcome.diagnostics.engine).toBe('mixed');
    expect(searchWithNotmuch).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: undefined }),
      expect.objectContaining({ accountIds: ['home'] }),
    );
    expect(searchWithImap).toHaveBeenCalledTimes(1);
    expect(outcome.diagnostics.fallbackReason).toBe('office: mirror disabled');
    expect(outcome.hits.map((hit) => hit.accountId)).toEqual(['home', 'office']);
  });

  it('searches every folder of an account without mirror, and says how many', async () => {
    const outcome = await executeSearch(config, { accountId: 'office', text: 'invoice', limit: 20 });

    expect(outcome.diagnostics.engine).toBe('imap');
    expect(outcome.diagnostics.query).toContain('office over IMAP, 3 folders');
    expect(searchWithNotmuch).not.toHaveBeenCalled();
  });

  it('uses only the index when every account in scope has a synced mirror', async () => {
    const outcome = await executeSearch(config, { accountId: 'home', text: 'invoice', limit: 20 });

    expect(outcome.diagnostics.engine).toBe('notmuch');
    expect(outcome.diagnostics.fallbackReason).toBeUndefined();
    expect(searchWithImap).not.toHaveBeenCalled();
  });

  it('sends a never synced mirror to the server without taking the index from the others', async () => {
    vi.mocked(readMirrorState).mockResolvedValue({ version: 1, accounts: {} });

    const outcome = await executeSearch(config, { accountId: 'home', text: 'invoice', limit: 20 });

    expect(outcome.diagnostics.engine).toBe('imap');
    expect(outcome.diagnostics.fallbackReason).toBe('home: the mirror has never completed a sync');
  });

  it('keeps a half-filled mirror out of the index until its first sync completes', async () => {
    vi.mocked(readMirrorState).mockResolvedValue({
      version:  1,
      accounts: { home: { lastSyncAt: new Date().toISOString(), lastSyncOk: false, indexedMessages: undefined } },
    });

    const outcome = await executeSearch(config, { accountId: 'home', text: 'invoice', limit: 20 });

    expect(outcome.diagnostics.engine).toBe('imap');
  });

  it('sends every account to the server when fresh data is required', async () => {
    const outcome = await executeSearch(config, { text: 'invoice', limit: 20 }, { requireFresh: true });

    expect(outcome.diagnostics.engine).toBe('imap');
    expect(searchWithNotmuch).not.toHaveBeenCalled();
    expect(searchWithImap).toHaveBeenCalledTimes(2);
  });

  it('searches on the server an account whose mirror lacks the folder, instead of leaving it out', async () => {
    const outcome = await executeSearch(config, { accountId: 'home', folder: 'Nowhere', limit: 20 });

    expect(outcome.diagnostics.engine).toBe('imap');
    expect(outcome.diagnostics.fallbackReason).toContain('home: "Nowhere" is not a folder of its local mirror');
  });
});
