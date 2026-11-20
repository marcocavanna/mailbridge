import { beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { withMailbox } from '#imap/connection';
import { listFolders } from '#imap/folders';
import { searchWithImap } from '#search/imap-search';

/* --------
 * Mocks
 * -------- */

// Connections are mocked at the pool boundary (testing.md): each folder answers with its own uids.
vi.mock('#imap/connection', () => ({ withMailbox: vi.fn() }));

vi.mock('#imap/folders', () => ({ listFolders: vi.fn() }));

/* --------
 * Fixture
 * -------- */

const account = accountSchema.parse({
  id:      'office',
  label:   'Office',
  address: 'someone@example.com',
  imap:    { host: 'imap.example.com', user: 'someone@example.com' },
  mirror:  { enabled: false },
});

function folder(path: string, isSelectable = true): Record<string, unknown> {
  return { path, name: path, delimiter: '/', specialUse: undefined, subscribed: true, isSelectable };
}

const dates: Record<string, string> = { 'INBOX': '2026-11-20T09:00:00Z', 'Archivio': '2026-11-19T09:00:00Z' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listFolders).mockResolvedValue(
    [folder('INBOX'), folder('Archivio'), folder('Clienti', false), folder('Rotta')] as unknown as Awaited<ReturnType<typeof listFolders>>,
  );
  vi.mocked(withMailbox).mockImplementation(async (_account, path, operation) => {
    if (path === 'Rotta') {
      throw new Error('cannot select');
    }

    const client = {
      search: async () => [1],
      fetch:  async function* fetch() {
        yield { uid: 1, flags: new Set<string>(), envelope: { subject: path, date: new Date(dates[path] ?? 0) } };
      },
    };

    return operation(client as never);
  });
});

/* --------
 * Behaviour
 * -------- */

describe('IMAP search across folders', () => {
  it('visits every selectable folder when none is given, newest first', async () => {
    const result = await searchWithImap(account, { text: 'invoice', limit: 20 });

    expect(result.folders).toEqual(['INBOX', 'Archivio', 'Rotta']);
    expect(result.hits.map((hit) => hit.folder)).toEqual(['INBOX', 'Archivio']);
  });

  it('reports a folder that fails without sinking the others', async () => {
    const result = await searchWithImap(account, { text: 'invoice', limit: 20 });

    expect(result.failures).toEqual(['Rotta: cannot select']);
    expect(result.hits).toHaveLength(2);
  });

  it('lets the failure of a folder chosen explicitly be the answer', async () => {
    await expect(searchWithImap(account, { folder: 'Rotta', limit: 20 })).rejects.toThrow('cannot select');
  });

  it('keeps the limit across folders', async () => {
    const result = await searchWithImap(account, { limit: 1 });

    expect(result.hits.map((hit) => hit.folder)).toEqual(['INBOX']);
  });
});
