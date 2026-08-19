import { z } from 'zod';

import { getConfig } from './context.js';
import { runTool, textResult } from './format.js';

import { runSync } from '#mirror/sync';
import { computeStalenessMinutes, readMirrorState } from '#mirror/state';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/* --------
 * Registration
 * -------- */

export function registerMirrorTools(server: McpServer): void {
  // ---- sync_status
  server.registerTool(
    'sync_status',
    {
      title:       'Local mirror status',
      description: 'Shows when each account was last synced and whether local search is reliable.',
      annotations: { readOnlyHint: true },
    },
    async () => runTool('sync_status', async () => {
      const config = await getConfig();
      const state = await readMirrorState();

      const lines = config.accounts.map((account) => {
        if (!account.mirror.enabled) {
          return `${account.id}: mirror disabled — searches on this account always go through IMAP`;
        }

        const entry = state.accounts[account.id];

        if (entry === undefined) {
          return `${account.id}: never synced — run \`sync_now\``;
        }

        const age = Math.round((Date.now() - new Date(entry.lastSyncAt).getTime()) / 60_000);

        return `${account.id}: last sync ${entry.lastSyncAt} (${age} min ago), outcome ${entry.lastSyncOk ? 'ok' : 'FAILED'}`;
      });

      const mirrored = config.accounts.filter((account) => account.mirror.enabled).map((account) => account.id);
      const staleness = computeStalenessMinutes(state, mirrored);

      const verdict = staleness === undefined
        ? 'Search will use IMAP: at least one account has never been synced.'
        : `The oldest mirror is ${Math.round(staleness)} minutes old.`;

      return textResult(`${lines.join('\n')}\n\n${verdict}`);
    }),
  );

  // ---- sync_now
  server.registerTool(
    'sync_now',
    {
      title:       'Sync the local mirror',
      description: [
        'Downloads new messages into the local mirror and reindexes, so search is up to date again.',
        'With no arguments it syncs every account; pass accountIds to limit it to the ones you need,',
        'which is much faster on large mailboxes.',
        'The sync is read-only from the server: nothing local travels back to the mailbox.',
      ].join(' '),
      inputSchema: {
        accountIds: z
          .array(z.string())
          .min(1)
          .optional()
          .describe('Accounts to sync. Absent = every account with the mirror enabled.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ accountIds }) => runTool('sync_now', async () => {
      const config = await getConfig();
      const summary = await runSync(config, { ...(accountIds === undefined ? {} : { accountIds }), source: 'mcp' });

      const lines = summary.runs.map((run) => (
        `${run.accountId}: ${run.ok ? 'ok' : 'FAILED'}${run.detail === undefined ? '' : `\n  ${run.detail.replace(/\n/g, '\n  ')}`}`
      ));

      const indexed = summary.indexedMessages === undefined
        ? 'count unavailable'
        : `${summary.indexedMessages} messages indexed`;

      return textResult(`Sync completed in ${summary.mailRoot} — ${indexed}.\n\n${lines.join('\n')}`);
    }),
  );
}
