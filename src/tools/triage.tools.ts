import { z } from 'zod';

import { requireAccount } from './context.js';
import { runTool, textResult } from './format.js';

import { findAwaitingReply } from '#search/awaiting-reply';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/* --------
 * Registration
 * -------- */

/**
 * Tools that answer a question about the state of a mailbox rather than about one message.
 */
export function registerTriageTools(server: McpServer): void {
  // ---- awaiting_reply
  server.registerTool(
    'awaiting_reply',
    {
      title:       'Threads waiting on a reply',
      description: [
        'Finds the conversations whose most recent message is not the account owner\'s — the ones where',
        'somebody is still waiting on them — sorted by how long they have been waiting.',
        '',
        'The criterion is the sender of the *last* message, not whether the owner ever wrote in the thread: a',
        'conversation they replied to and which then came back still needs them.',
        '',
        'Newsletters and automated mail are excluded by default, since nobody is waiting on those.',
        '',
        'It runs on the local mirror, so it costs no server round trips but only sees mail as of the last sync.',
        'Results carry a folder and a Message-Id rather than a uid: use resolve_message to act on one.',
      ].join('\n'),
      inputSchema: {
        accountId:   z.string().describe('Account id, as returned by list_accounts.'),
        days:        z.number().int().min(1).max(730).optional().describe('How far back to look (default 60).'),
        includeBulk: z.boolean().optional().describe('Include newsletters and automated mail (default false).'),
        limit:       z.number().int().min(1).max(200).optional().describe('How many threads to report (default 50).'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ accountId, days, includeBulk, limit }) => runTool('awaiting_reply', async () => {
      const account = await requireAccount(accountId);

      const result = await findAwaitingReply(account, {
        ...(days === undefined ? {} : { days }),
        ...(includeBulk === undefined ? {} : { includeBulk }),
        ...(limit === undefined ? {} : { limit }),
      });

      if (result.threads.length === 0) {
        return textResult(`Nothing awaiting a reply in "${accountId}" (${result.examined} threads examined).`);
      }

      const body = result.threads.map((thread, index) => {
        const sender = thread.lastFrom === undefined
          ? 'unknown sender'
          : (thread.lastFrom.name === undefined ? thread.lastFrom.address : `${thread.lastFrom.name} <${thread.lastFrom.address}>`);

        return [
          `${index + 1}. ${thread.waitingDays} days — ${sender}${thread.neverReplied ? ' (never replied)' : ''}`,
          `   subject: ${thread.subject}`,
          `   ${thread.messageCount} messages${thread.folder === undefined ? '' : ` · folder: ${thread.folder}`}`,
          thread.messageId === undefined ? undefined : `   message-id: ${thread.messageId}`,
        ]
          .filter((line): line is string => line !== undefined)
          .join('\n');
      }).join('\n\n');

      return textResult([
        `${result.threads.length} threads awaiting a reply in "${accountId}", oldest first`,
        `  ${result.examined} threads examined from the local mirror`,
        '',
        body,
      ].join('\n'));
    }),
  );
}
