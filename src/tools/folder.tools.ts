import { z } from 'zod';

import { requireAccount } from './context.js';
import { runTool, textResult } from './format.js';

import { createFolder, deleteFolder, readFolderCounts, renameFolder, setFolderSubscription } from '#imap/mailboxes';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/* --------
 * Registration
 * -------- */

/**
 * Folder management.
 *
 * `delete_folder` is the only operation in the project that could destroy data, and it is fenced off:
 * only empty folders, with no subfolders, and never a special folder. See `.claude/rules/security.md` §4.
 */
export function registerFolderTools(server: McpServer): void {
  // ---- create_folder
  server.registerTool(
    'create_folder',
    {
      title:       'Create a folder',
      description: [
        'Creates a folder on the server. Nesting is written with a slash — `Clients/Acme` — and translated',
        'to whatever separator this server uses.',
      ].join(' '),
      inputSchema: {
        accountId: z.string(),
        path:      z.string().min(1).describe('Folder name, optionally nested as `Parent/Child`.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ accountId, path }) => runTool('create_folder', async () => {
      const account = await requireAccount(accountId);
      const result = await createFolder(account, path);

      return textResult(result.created
        ? `Folder "${result.path}" created.`
        : `Folder "${result.path}" already existed: nothing changed.`);
    }),
  );

  // ---- rename_folder
  server.registerTool(
    'rename_folder',
    {
      title:       'Rename or move a folder',
      description: [
        'Renames a folder. On IMAP this is also how a folder is moved under a different parent:',
        'rename `Acme` to `Clients/Acme`. The messages travel with it, nothing is copied or lost.',
      ].join(' '),
      inputSchema: {
        accountId: z.string(),
        path:      z.string().min(1).describe('Current full path.'),
        newPath:   z.string().min(1).describe('New name or path.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ accountId, path, newPath }) => runTool('rename_folder', async () => {
      const account = await requireAccount(accountId);
      const result = await renameFolder(account, path, newPath);

      return textResult(`Folder "${result.path}" renamed to "${result.newPath}".`);
    }),
  );

  // ---- delete_folder
  server.registerTool(
    'delete_folder',
    {
      title:       'Delete an empty folder',
      description: [
        'Deletes a folder, only if it is empty and has no subfolders. A folder holding messages is refused',
        'with the count, because deleting it on IMAP would destroy those messages: move them elsewhere first.',
        'Special folders (inbox, sent, drafts, archive, trash, junk) are never deletable.',
      ].join(' '),
      inputSchema: {
        accountId: z.string(),
        path:      z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ accountId, path }) => runTool('delete_folder', async () => {
      const account = await requireAccount(accountId);
      const result = await deleteFolder(account, path);

      return textResult(`Empty folder "${result.path}" deleted.`);
    }),
  );

  // ---- folder_counts
  server.registerTool(
    'folder_counts',
    {
      title:       'Count a folder\'s messages',
      description: 'Total and unread message counts for a folder, without reading any of them.',
      inputSchema: {
        accountId: z.string(),
        path:      z.string().min(1),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, path }) => runTool('folder_counts', async () => {
      const account = await requireAccount(accountId);
      const counts = await readFolderCounts(account, path);

      return textResult(`${counts.path}: ${counts.messages} messages, ${counts.unseen} unread.`);
    }),
  );

  // ---- set_folder_subscription
  server.registerTool(
    'set_folder_subscription',
    {
      title:       'Subscribe or unsubscribe a folder',
      description: [
        'Changes whether a folder is subscribed, which is what decides if mail clients display it.',
        'It creates and deletes nothing.',
      ].join(' '),
      inputSchema: {
        accountId:  z.string(),
        path:       z.string().min(1),
        subscribed: z.boolean(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountId, path, subscribed }) => runTool('set_folder_subscription', async () => {
      const account = await requireAccount(accountId);
      const result = await setFolderSubscription(account, path, subscribed);

      return textResult(`Folder "${result.path}" ${result.subscribed ? 'subscribed' : 'unsubscribed'}.`);
    }),
  );
}
