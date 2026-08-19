import { z } from 'zod';

import { requireAccount } from './context.js';
import { runTool, textResult } from './format.js';

import { flagMessages, getBulkLimit, moveMessages, moveMessagesToSpecial } from '#imap/bulk';
import { specialFolderSchema } from '#config/accounts.schema';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BulkMoveResult } from '#imap/bulk';

/* --------
 * Helpers
 * -------- */

function describeMove(result: BulkMoveResult): string {
  const lines = [`${result.moved} messages moved to "${result.destination}".`];

  /*
   * A shortfall is not an error: another client may have moved or expunged something in the meantime.
   * It is reported because silence here would look like a complete success.
   */
  if (result.moved < result.requested) {
    lines.push(
      `Requested ${result.requested}, the server confirmed ${result.moved}.`,
      'The difference is usually mail another client had already moved. Search again to see the current state.',
    );
  }

  return lines.join('\n');
}

const uidsShape = z
  .array(z.number().int().positive())
  .min(1)
  .describe('uids of the messages, as returned by search, list or list_subscriptions.');

/* --------
 * Registration
 * -------- */

/**
 * Bulk operations.
 *
 * They exist because reorganizing mail one message at a time is wrong twice over: one round trip per
 * message, and uids shift as messages leave a folder, so a loop over a stale list starts moving the
 * wrong mail. Everything here hands the whole set to the server in a single IMAP operation.
 */
export function registerBulkTools(server: McpServer): void {
  // ---- move_messages
  server.registerTool(
    'move_messages',
    {
      title:       'Move several messages',
      description: [
        'Moves a set of messages to another folder in a single operation.',
        `Up to ${getBulkLimit()} messages at a time; beyond that, split the work and repeat.`,
        'Reversible: the messages exist in the destination folder.',
      ].join(' '),
      inputSchema: {
        accountId:   z.string(),
        folder:      z.string().describe('Source folder.'),
        uids:        uidsShape,
        destination: z.string().describe('Destination folder, full path. Create it first if it does not exist.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ accountId, folder, uids, destination }) => runTool('move_messages', async () => {
      const account = await requireAccount(accountId);

      return textResult(describeMove(await moveMessages(account, folder, uids, destination)));
    }),
  );

  // ---- file_messages
  server.registerTool(
    'file_messages',
    {
      title:       'File several messages into a special folder',
      description: [
        'Moves a set of messages into one of the account\'s special folders — archive, trash, junk, and so on —',
        'resolved automatically, so the caller does not need to know what this server calls it.',
        '',
        'Choosing `trash` puts mail in the Trash folder: it is a move, and recoverable from there, but note that',
        'mail servers commonly purge Trash on their own schedule. `archive` keeps mail indefinitely.',
      ].join(' '),
      inputSchema: {
        accountId: z.string(),
        folder:    z.string().describe('Source folder.'),
        uids:      uidsShape,
        target:    specialFolderSchema.describe('Special folder to file into: archive, trash, junk, sent, drafts, inbox.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ accountId, folder, uids, target }) => runTool('file_messages', async () => {
      const account = await requireAccount(accountId);
      const result = await moveMessagesToSpecial(account, folder, uids, target);

      const note = target === 'trash'
        ? '\n\nThey are in the Trash and can be moved back, but the server may purge that folder on its own schedule.'
        : '';

      return textResult(`${describeMove(result)}${note}`);
    }),
  );

  // ---- flag_messages
  server.registerTool(
    'flag_messages',
    {
      title:       'Flag several messages',
      description: [
        'Adds or removes flags on a set of messages in a single operation — marking a whole newsletter as read,',
        'for instance. Reversible.',
      ].join(' '),
      inputSchema: {
        accountId: z.string(),
        folder:    z.string(),
        uids:      uidsShape,
        add:       z.array(z.enum(['\\Seen', '\\Flagged', '\\Answered'])).optional(),
        remove:    z.array(z.enum(['\\Seen', '\\Flagged', '\\Answered'])).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountId, folder, uids, add, remove }) => runTool('flag_messages', async () => {
      const account = await requireAccount(accountId);

      const result = await flagMessages(account, folder, uids, {
        ...(add === undefined ? {} : { add }),
        ...(remove === undefined ? {} : { remove }),
      });

      const changes = [
        result.added.length === 0 ? undefined : `added ${result.added.join(', ')}`,
        result.removed.length === 0 ? undefined : `removed ${result.removed.join(', ')}`,
      ].filter((part): part is string => part !== undefined);

      return textResult(`${result.requested} messages updated: ${changes.join('; ')}.`);
    }),
  );
}
