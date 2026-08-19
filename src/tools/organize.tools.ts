import { z } from 'zod';

import { requireAccount } from './context.js';
import { runTool, textResult } from './format.js';

import { archiveMessage, moveMessage, setFlags } from '#imap/flags';
import { resolveSpecialFolder } from '#imap/folders';
import { findUidByMessageId } from '#search/imap-search';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/* --------
 * Registration
 * -------- */

export function registerOrganizeTools(server: McpServer): void {
  // ---- set_flags
  server.registerTool(
    'set_flags',
    {
      title:       'Flag a message',
      description: [
        'Adds or removes flags on a message: seen, flagged, answered.',
        'A reversible operation. Deletion is not supported by this server.',
      ].join(' '),
      inputSchema: {
        accountId: z.string(),
        folder:    z.string(),
        uid:       z.number().int().positive(),
        add:       z.array(z.enum(['\\Seen', '\\Flagged', '\\Answered', '\\Draft'])).optional(),
        remove:    z.array(z.enum(['\\Seen', '\\Flagged', '\\Answered', '\\Draft'])).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountId, folder, uid, add, remove }) => runTool('set_flags', async () => {
      const account = await requireAccount(accountId);

      await setFlags(account, folder, uid, {
        ...(add === undefined ? {} : { add }),
        ...(remove === undefined ? {} : { remove }),
      });

      return textResult(`Flags updated on ${accountId}/${folder} uid ${uid}.`);
    }),
  );

  // ---- move_message
  server.registerTool(
    'move_message',
    {
      title:       'Move a message',
      description: 'Moves a message to another folder. Reversible: the message still exists, elsewhere.',
      inputSchema: {
        accountId:   z.string(),
        folder:      z.string().describe('Source folder.'),
        uid:         z.number().int().positive(),
        destination: z.string().describe('Destination folder, full path.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ accountId, folder, uid, destination }) => runTool('move_message', async () => {
      const account = await requireAccount(accountId);
      const result = await moveMessage(account, folder, uid, destination);

      const newUid = result.uid === undefined ? 'uid not reported by the server' : `new uid ${result.uid}`;

      return textResult(`Message moved to "${result.destination}" (${newUid}).`);
    }),
  );

  // ---- archive_message
  server.registerTool(
    'archive_message',
    {
      title:       'Archive a message',
      description: 'Moves a message to the account\'s archive folder, resolved automatically.',
      inputSchema: {
        accountId: z.string(),
        folder:    z.string(),
        uid:       z.number().int().positive(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ accountId, folder, uid }) => runTool('archive_message', async () => {
      const account = await requireAccount(accountId);
      const result = await archiveMessage(account, folder, uid);

      return textResult(`Message archived in "${result.destination}".`);
    }),
  );

  // ---- resolve_message
  server.registerTool(
    'resolve_message',
    {
      title:       'Resolve a message from its Message-Id',
      description: [
        'Finds the IMAP uid of a message given its Message-Id.',
        'Needed after a search on the local index, which returns the Message-Id but not the uid.',
      ].join(' '),
      inputSchema: {
        accountId: z.string(),
        messageId: z.string().describe('Message-Id of the message, as shown by the search.'),
        folder:    z.string().optional().describe('Folder to search in. Absent = inbox.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, messageId, folder }) => runTool('resolve_message', async () => {
      const account = await requireAccount(accountId);
      const target = folder ?? (await resolveSpecialFolder(account, 'inbox'));
      const uid = await findUidByMessageId(account, target, messageId);

      if (uid === undefined) {
        return textResult(`No message with Message-Id ${messageId} in ${accountId}/${target}.`);
      }

      return textResult(`Found: ${accountId}/${target} uid ${uid}.`);
    }),
  );
}
