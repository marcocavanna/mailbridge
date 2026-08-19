import { findAccount, loadAccountsConfig } from '#config/load-accounts';

import type { Account, AccountsConfig } from '#config/accounts.schema';

/* --------
 * Internal state
 * -------- */

let cached: AccountsConfig | undefined;

/* --------
 * Implementation
 * -------- */

/**
 * The account configuration, loaded once per process.
 */
export async function getConfig(): Promise<AccountsConfig> {
  if (cached === undefined) {
    cached = await loadAccountsConfig();
  }

  return cached;
}

/**
 * Invalidates the cache. Needed after an account is added while the server is running.
 */
export function invalidateConfig(): void {
  cached = undefined;
}

export async function requireAccount(accountId: string): Promise<Account> {
  return findAccount(await getConfig(), accountId);
}
