import { loadOverview } from './overview.js';
import { prompts, required, withSpinner } from './prompt-helpers.js';
import { badge, colors, formatAge, formatBytes, formatCount, formatPath, heading, table } from './ui.js';

import { readConfigOrEmpty } from '#config/write-accounts';
import { resolveMailRoot, resolveMaildirPath } from '#mirror/paths';
import { runSync } from '#mirror/sync';
import { MailbridgeError } from '#shared/errors';

import type { AccountOverview } from './overview.js';
import type { SyncSummary } from '#mirror/sync';

/* --------
 * Constants
 * -------- */

const STALE_AFTER_MS = 30 * 60_000;

/* --------
 * Helpers
 * -------- */

function mirrorable(entries: readonly AccountOverview[]): AccountOverview[] {
  return entries.filter((entry) => entry.account.mirror.enabled);
}

/**
 * Ordering hint: accounts never synced, or synced longest ago, come first.
 */
function stalenessRank(entry: AccountOverview): number {
  if (entry.sync === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  return Date.now() - new Date(entry.sync.lastSyncAt).getTime();
}

function renderSyncSummary(summary: SyncSummary): string {
  const rows = summary.runs.map((run) => ({
    accountId: run.accountId,
    ok:        run.ok,
    detail:    run.detail,
  }));

  const rendered = table(rows, [
    { header: 'ACCOUNT', value: (row) => colors.bold(row.accountId) },
    { header: 'OUTCOME', value: (row) => (row.ok ? badge('ok', 'ok') : badge('failed', 'fail')) },
  ]);

  const failures = summary.runs.filter((run) => !run.ok && run.detail !== undefined);

  const detail = failures.length === 0
    ? ''
    : `\n\n${failures.map((run) => `  ${colors.red('→')} ${run.accountId}: ${(run.detail ?? '').replace(/\n/g, '\n     ')}`).join('\n')}`;

  return `${rendered}${detail}`;
}

/* --------
 * Implementation
 * -------- */

/**
 * Shows the mirror status per account, with the last sync.
 */
export async function showSyncState(): Promise<void> {
  const entries = await withSpinner(
    'Reading mirror status',
    async () => loadOverview({ withStats: true }),
    { successMessage: () => 'Status read' },
  );

  const candidates = mirrorable(entries);

  if (candidates.length === 0) {
    prompts.log.warn('No account has the mirror enabled.');

    return;
  }

  const rendered = table(candidates, [
    { header: 'ACCOUNT', value: (entry) => colors.bold(entry.account.id) },
    {
      header: 'LAST SYNC',
      value:  (entry) => {
        if (entry.sync === undefined) {
          return badge('never', 'warn');
        }

        return entry.sync.lastSyncOk ? badge(formatAge(entry.sync.lastSyncAt), 'ok') : badge('failed', 'fail');
      },
    },
    { header: 'ON DISK', value: (entry) => formatBytes(entry.stats?.sizeBytes), align: 'right' },
    { header: 'MESSAGES', value: (entry) => formatCount(entry.stats?.indexedMessages), align: 'right' },
  ]);

  prompts.log.message(`${heading('Local mirror')}\n\n${rendered}`);

  prompts.log.info([
    `Mirror root: ${colors.bold(formatPath(resolveMailRoot()))}`,
    ...candidates.map((entry) => `  ${entry.account.id} → ${formatPath(resolveMaildirPath(entry.account))}`),
  ].join('\n  '));
}

/**
 * Runs the sync, showing progress account by account.
 */
export async function runSyncWithFeedback(accountIds?: readonly string[]): Promise<void> {
  const config = await readConfigOrEmpty();

  if (config.accounts.length === 0) {
    throw new MailbridgeError('config_missing', 'No accounts configured.', {
      remediation: 'Add one with `mailbridge account add`.',
    });
  }

  const summary = await withSpinner(
    'Preparing the sync',
    async (handle) => runSync(config, {
      ...(accountIds === undefined ? {} : { accountIds }),
      source: 'cli',
      onProgress: (event) => {
        switch (event.kind) {
          case 'account-start':
            handle.message(`[${event.position}/${event.total}] ${event.accountId}`);
            break;
          case 'account-done':
            handle.message(`${event.accountId}: ${event.ok ? 'ok' : 'failed'}`);
            break;
          case 'index-start':
            handle.message('Indexing with notmuch');
            break;
          case 'index-done':
            handle.message(
              event.indexedMessages === undefined
                ? 'Indexing complete'
                : `${formatCount(event.indexedMessages)} messages indexed`,
            );
            break;
        }
      },
    }),
    {
      successMessage: (result) => {
        const failures = result.runs.filter((run) => !run.ok).length;

        return failures === 0 ? 'Sync complete' : `Sync complete with ${failures} errors`;
      },
      outcome:        (result) => (result.runs.some((run) => !run.ok) ? 'problem' : 'ok'),
      failureMessage: 'Sync interrupted',
    },
  );

  const failed = summary.runs.filter((run) => !run.ok);

  prompts.log.message(renderSyncSummary(summary));

  prompts.log.info([
    `Mirror in ${colors.bold(formatPath(summary.mailRoot))} · index: ${formatCount(summary.indexedMessages)} messages`,
    `One directory per account: ${summary.runs.map((run) => run.accountId).join(', ')}`,
  ].join('\n  '));

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * Multi-select of the accounts to sync, with the last sync shown next to each one.
 *
 * The stalest ones, and those never synced, come preselected: it is almost always what you want, and it
 * still leaves you free to change the selection.
 */
export async function syncFlow(): Promise<void> {
  const entries = await loadOverview();
  const candidates = mirrorable(entries).sort((left, right) => stalenessRank(right) - stalenessRank(left));

  if (candidates.length === 0) {
    prompts.log.warn('No account has the mirror enabled.');
    prompts.note('mailbridge account edit', 'To enable it');

    return;
  }

  const stale = candidates.filter((entry) => entry.sync === undefined || stalenessRank(entry) > STALE_AFTER_MS);

  const selected = required(await prompts.multiselect({
    message: 'Which accounts should I sync?',
    options: candidates.map((entry) => ({
      value: entry.account.id,
      label: entry.account.id,
      hint:  entry.sync === undefined
        ? 'never synced'
        : `last sync ${formatAge(entry.sync.lastSyncAt)}${entry.sync.lastSyncOk ? '' : ' (failed)'}`,
    })),
    initialValues: (stale.length > 0 ? stale : candidates).map((entry) => entry.account.id),
    required:      true,
  }));

  await runSyncWithFeedback(selected);
}

/**
 * Sync for unattended runs: flat lines, no spinner, no colour.
 *
 * It is a separate path rather than a flag inside the normal rendering, because what is needed here is
 * the opposite: every line carries a timestamp and survives being read in a log file weeks later, where
 * a spinner would be an unreadable run of control characters.
 */
export async function runSyncQuiet(accountIds?: readonly string[], source = 'schedule'): Promise<void> {
  const stamp = (): string => (new Date().toISOString());
  const write = (message: string): void => {
    process.stdout.write(`${stamp()} ${message}\n`);
  };

  const config = await readConfigOrEmpty();

  if (config.accounts.length === 0) {
    write('no accounts configured: nothing to sync');
    process.exitCode = 1;

    return;
  }

  write(`sync started (${accountIds === undefined ? 'all accounts' : accountIds.join(', ')})`);

  try {
    const summary = await runSync(config, {
      ...(accountIds === undefined ? {} : { accountIds }),
      source,
      onProgress: (event) => {
        if (event.kind === 'account-done') {
          write(`  ${event.accountId}: ${event.ok ? 'ok' : 'FAILED'}`);
        }
      },
    });

    const failed = summary.runs.filter((run) => !run.ok);

    for (const run of failed) {
      write(`  ${run.accountId}: ${(run.detail ?? 'no detail').replace(/\n/g, ' | ')}`);
    }

    write([
      `sync complete: ${summary.runs.length - failed.length}/${summary.runs.length} ok`,
      `index ${summary.indexedMessages ?? 'n/a'} messages`,
      `mirror in ${summary.mailRoot}`,
    ].join(', '));

    if (failed.length > 0) {
      process.exitCode = 1;
    }
  } catch (cause) {
    write(`sync interrupted: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exitCode = 1;
  }
}
