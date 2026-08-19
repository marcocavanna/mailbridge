import { z } from 'zod';

import { runTool, textResult } from './format.js';

import {
  isUpdateCheckEnabled,
  readPendingNotice,
  readUpdateState,
  resolveInstallKind,
  resolveUpdateCommand,
  suppressUpdateNotices,
} from '#shared/update';
import { VERSION } from '#shared/version';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/* --------
 * Registration
 * -------- */

/**
 * Version and update tools.
 *
 * There is deliberately **no tool that performs the upgrade**, which is where this parts company with
 * comparable servers. This one reads untrusted mail: a tool that runs `npm install -g` would put package
 * installation one step away from content an attacker controls, and "the user consented" is thin cover when
 * the request to upgrade could have been planted in an email. The command is reported; running it stays
 * with the person at the keyboard.
 */
export function registerUpdateTools(server: McpServer): void {
  // ---- update_status
  server.registerTool(
    'update_status',
    {
      title:       'Version and available update',
      description: [
        'Reports the running version, the latest one seen on the npm registry, and the exact command to',
        'upgrade this particular install.',
        '',
        'This server never installs anything: the command is for the user to run.',
      ].join('\n'),
      annotations: { readOnlyHint: true },
    },
    async () => runTool('update_status', async () => {
      const installKind = resolveInstallKind();

      const describeInstall = installKind === 'source'
        ? 'a source checkout'
        : (installKind === 'npm-global' ? 'an npm install' : 'an unrecognized layout');

      if (!isUpdateCheckEnabled()) {
        return textResult([
          `Running mailbridge ${VERSION} from ${describeInstall}.`,
          'Update checks are disabled (MAILBRIDGE_NO_UPDATE_CHECK, NO_UPDATE_NOTIFIER or CI).',
        ].join('\n'));
      }

      const state = readUpdateState();
      const notice = readPendingNotice();

      const lines = [`Running mailbridge ${VERSION} from ${describeInstall}.`];

      if (notice !== undefined) {
        lines.push(
          `A newer version is available: ${notice.latestVersion}.`,
          `Upgrade with: ${notice.command}`,
          'Run that yourself — this server does not install anything.',
        );
      } else if (state?.latestVersion === undefined) {
        lines.push(
          'No published version has been seen yet: either the registry has not been reached, or the package is',
          'not published under this name.',
          `If you built from source, upgrade with: ${resolveUpdateCommand(installKind)}`,
        );
      } else if (state.suppressedUntil !== undefined && new Date(state.suppressedUntil).getTime() > Date.now()) {
        lines.push(`Latest published: ${state.latestVersion}. Reminders are silenced until ${state.suppressedUntil}.`);
      } else {
        lines.push(`This is the latest published version (${state.latestVersion}).`);
      }

      if (state?.lastCheckedAt !== undefined) {
        lines.push(`Registry last checked: ${state.lastCheckedAt}`);
      }

      return textResult(lines.join('\n'));
    }),
  );

  // ---- dismiss_update
  server.registerTool(
    'dismiss_update',
    {
      title:       'Silence update reminders',
      description: [
        'Silences update notices for a number of hours. Use it when the user asks to be reminded later or to',
        'stop being reminded. Pass 0 to clear the suppression and let notices return.',
      ].join(' '),
      inputSchema: {
        hours: z.number().min(0).max(24 * 365).describe('Hours to stay silent. 0 clears the suppression.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ hours }) => runTool('dismiss_update', async () => {
      const until = suppressUpdateNotices(hours);

      if (until === undefined) {
        return textResult('Update reminders re-enabled.');
      }

      const notice = readUpdateState()?.latestVersion;

      return textResult([
        `Update reminders silenced until ${until}.`,
        notice === undefined ? undefined : `Latest published version remains ${notice}.`,
        'To silence them permanently, set MAILBRIDGE_NO_UPDATE_CHECK=1 in the environment.',
      ].filter((line): line is string => line !== undefined).join('\n'));
    }),
  );
}
