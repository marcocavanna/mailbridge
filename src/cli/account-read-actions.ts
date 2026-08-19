import { renderAccountDetail, renderAccountList, renderAccountStatus, renderHealth, summarizeHealth } from './account-view.js';
import { pickAccount, requireOverview } from './account-resolve.js';
import { loadOverview } from './overview.js';
import { prompts, withSpinner } from './prompt-helpers.js';
import { colors, formatBytes, formatPath, heading } from './ui.js';

import { checkAccountHealth } from '#imap/health';
import { resolveMailRoot } from '#mirror/paths';
import { MailbridgeError } from '#shared/errors';

/* --------
 * Read actions
 * -------- */

export async function listAccounts(): Promise<void> {
  const entries = await loadOverview();

  if (entries.length === 0) {
    prompts.log.warn('No accounts configured.');
    prompts.note('mailbridge account add', 'To add one');

    return;
  }

  prompts.log.message(`${heading(`${entries.length} accounts`)}\n\n${renderAccountList(entries)}`);
}

export async function showStatus(accountId?: string): Promise<void> {
  const entries = await withSpinner(
    'Collecting sizes and counts',
    async () => loadOverview({ withStats: true }),
    { successMessage: (result) => `Status collected for ${result.length} accounts` },
  );

  if (entries.length === 0) {
    prompts.log.warn('No accounts configured.');

    return;
  }

  if (accountId !== undefined) {
    const entry = entries.find((candidate) => candidate.account.id === accountId);

    if (entry === undefined) {
      throw new MailbridgeError('account_not_found', `No account with id "${accountId}".`);
    }

    prompts.log.message(`${heading(entry.account.id)}\n\n${renderAccountDetail(entry)}`);

    return;
  }

  prompts.log.message(`${heading('Mirror status')}\n\n${renderAccountStatus(entries)}`);

  const total = entries.reduce((sum, entry) => sum + (entry.stats?.sizeBytes ?? 0), 0);

  // Where the files live is the first thing people look for and the last thing they find: it belongs
  // here, not only in the detail view of a single account.
  prompts.log.info([
    `Total on disk: ${formatBytes(total)}`,
    `Mirrors live in ${colors.bold(formatPath(resolveMailRoot()))}, one directory per account.`,
  ].join('\n  '));
}

export async function testAccount(accountId?: string): Promise<void> {
  const target = accountId ?? (await pickAccount('Which account should I test?'));
  const entry = await requireOverview(target);

  // The spinner reports success only if the test passed: a green glyph on a failed test is wrong
  // information at exactly the point where the eye lands first.
  const health = await withSpinner(
    `Testing IMAP and SMTP for ${target}`,
    async () => checkAccountHealth(entry.account),
    {
      successMessage: (result) => (
        summarizeHealth(result) === 'ok' ? `${target}: connections ok` : `${target}: problems found`
      ),
      outcome:        (result) => (summarizeHealth(result) === 'ok' ? 'ok' : 'problem'),
      failureMessage: `${target}: test did not complete`,
    },
  );

  const outcome = summarizeHealth(health);

  if (outcome !== 'ok') {
    prompts.log.warn(`${target}: ${outcome === 'fail' ? 'the account is not usable' : 'IMAP ok, sending unavailable'}`);
  }

  prompts.log.message(renderHealth(health));

  if (outcome === 'fail') {
    process.exitCode = 1;
  }
}
