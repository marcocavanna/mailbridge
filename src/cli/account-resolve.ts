import { findOverview, loadOverview } from './overview.js';
import { prompts, required } from './prompt-helpers.js';

import { MailbridgeError } from '#shared/errors';

import type { AccountOverview } from './overview.js';

/* --------
 * Implementation
 * -------- */

/**
 * Resolves an account by id, with an error that says where to look.
 */
export async function requireOverview(accountId: string): Promise<AccountOverview> {
  const entry = await findOverview(accountId);

  if (entry === undefined) {
    throw new MailbridgeError('account_not_found', `No account with id "${accountId}".`, {
      remediation: 'List them with `mailbridge account list`.',
    });
  }

  return entry;
}

/**
 * Asks which account, when the id did not come from the command line.
 *
 * With a single account it does not ask: a prompt with one option is an obstacle, not a choice.
 */
export async function pickAccount(message: string): Promise<string> {
  const entries = await loadOverview();

  if (entries.length === 0) {
    throw new MailbridgeError('config_missing', 'No accounts configured.', {
      remediation: 'Add one with `mailbridge account add`.',
    });
  }

  if (entries.length === 1) {
    return entries[0]?.account.id ?? '';
  }

  return required(await prompts.select({
    message,
    options: entries.map((entry) => ({
      value: entry.account.id,
      label: entry.account.id,
      hint:  entry.account.address,
    })),
  }));
}
