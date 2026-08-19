#!/usr/bin/env node

import { Command } from 'commander';

import { interactiveMenu } from './menu.js';
import { CancelledError, prompts } from './prompt-helpers.js';
import { framed, VERSION } from './shell.js';
import {
  disableSchedule,
  enableSchedule,
  runScheduleNow,
  showScheduleLogs,
  showScheduleStatus,
} from './schedule-actions.js';
import { listAccounts, showStatus, testAccount } from './account-read-actions.js';
import { addAccountFlow, editAccountFlow, removeAccountFlow } from './account-write-actions.js';
import { runSyncQuiet, runSyncWithFeedback, showSyncState, syncFlow } from './sync-actions.js';
import { colors } from './ui.js';

import { describeUnknownError } from '#shared/errors';

/* --------
 * Command wiring
 * -------- */

function buildProgram(): Command {
  const program = new Command();

  program
    .name('mailbridge')
    .description('IMAP/SMTP mailboxes for AI assistants: management, local mirror and MCP server.')
    .version(VERSION)
    .action(async () => interactiveMenu());

  // ---- account
  const account = program.command('account').description('Manage the configured accounts');

  account.command('list').description('List the accounts').action(framed(listAccounts));

  account
    .command('status [accountId]')
    .description('Mirror status: size on disk, indexed messages, last sync')
    .action(async (accountId?: string) => framed(async () => showStatus(accountId))());

  account
    .command('test [accountId]')
    .description('Test the IMAP and SMTP connection, without sending anything')
    .action(async (accountId?: string) => framed(async () => testAccount(accountId))());

  account.command('add').description('Add an account').action(framed(addAccountFlow));

  account
    .command('edit [accountId]')
    .description('Edit an account\'s fields, password or mirror')
    .action(async (accountId?: string) => framed(async () => editAccountFlow(accountId))());

  account
    .command('remove [accountId]')
    .description('Remove an account from the configuration')
    .action(async (accountId?: string) => framed(async () => removeAccountFlow(accountId))());

  // ---- sync
  program
    .command('sync [accountIds...]')
    .description('Sync the local mirror. With no arguments it opens the selection; --all takes them all.')
    .option('--all', 'sync every account with the mirror enabled')
    .option('--status', 'show the status only, without syncing')
    .option('--quiet', 'flat output with timestamps, for logs and unattended runs')
    .action(async (accountIds: string[], options: { all?: boolean; status?: boolean; quiet?: boolean }) => {
      /**
       * `--quiet` does not go through `framed`: the output lands in a log file, where clack's boxes and
       * spinner become unreadable control sequences. This is the path the LaunchAgent uses.
       */
      if (options.quiet === true) {
        await runSyncQuiet(accountIds.length > 0 ? accountIds : undefined);

        return;
      }

      await framed(async () => {
        if (options.status === true) {
          await showSyncState();

          return;
        }

        if (options.all === true) {
          await runSyncWithFeedback();

          return;
        }

        if (accountIds.length > 0) {
          await runSyncWithFeedback(accountIds);

          return;
        }

        await syncFlow();
      })();
    });

  // ---- schedule
  const schedule = program
    .command('schedule')
    .description('Periodic background sync (LaunchAgent)');

  schedule.command('status').description('Scheduled sync status').action(framed(showScheduleStatus));

  schedule
    .command('enable')
    .description('Enable or reconfigure the scheduled sync')
    .option('--interval <minutes>', 'cadence in minutes; without this option it is asked for')
    .option('--all', 'every account with the mirror enabled')
    .option('--accounts <ids...>', 'these accounts only')
    .action(async (options: { interval?: string; all?: boolean; accounts?: string[] }) => framed(async () => {
      const intervalMinutes = options.interval === undefined ? undefined : Number.parseInt(options.interval, 10);

      if (intervalMinutes !== undefined && (Number.isNaN(intervalMinutes) || intervalMinutes < 1)) {
        prompts.log.error(`Invalid cadence: ${options.interval ?? ''}.`);
        process.exitCode = 1;

        return;
      }

      const accountIds = options.all === true ? [] : options.accounts;

      await enableSchedule({
        ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
        ...(accountIds === undefined ? {} : { accountIds }),
      });
    })());

  schedule.command('disable').description('Disable the scheduled sync').action(framed(disableSchedule));
  schedule.command('run').description('Run now, in the agent\'s environment').action(framed(runScheduleNow));
  schedule.command('logs').description('Last lines of the agent\'s logs').action(framed(showScheduleLogs));

  // ---- serve
  program
    .command('serve')
    .description('Start the MCP server on stdio (invoked by the client, not by hand)')
    .action(async () => {
      /**
       * Dynamic import: the server must not be loaded by the interactive paths, and above all **nothing
       * is printed to stdout** here — that is the JSON-RPC transport. Every diagnostic goes to stderr,
       * as the logger does.
       */
      const { startServer } = await import('../server-runtime.js');

      await startServer();
    });

  return program;
}

/* --------
 * Bootstrap
 * -------- */

async function main(): Promise<void> {
  await buildProgram().parseAsync(process.argv);
}

main().catch((cause: unknown) => {
  if (cause instanceof CancelledError) {
    prompts.cancel('Cancelled.');
    process.exit(130);
  }

  prompts.log.error(describeUnknownError(cause));
  prompts.outro(colors.red('Interrupted.'));
  process.exit(1);
});
