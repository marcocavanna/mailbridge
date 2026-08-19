import { readConfigOrEmpty } from '#config/write-accounts';
import { readMirrorStats } from '#mirror/stats';
import { readMirrorState } from '#mirror/state';
import { hasCredentials } from '#secrets/keychain';

import type { Account } from '#config/accounts.schema';
import type { MirrorStats } from '#mirror/stats';
import type { AccountSyncState } from '#mirror/state';

/* --------
 * Types
 * -------- */

export interface AccountOverview {
  account: Account;
  hasCredential: boolean;
  sync: AccountSyncState | undefined;
  /** Absent when statistics were not requested: they are the slow part. */
  stats: MirrorStats | undefined;
}

export interface LoadOverviewOptions {
  /**
   * Measure size on disk and indexed counts. It costs one `du` and two `notmuch count` per account, so
   * it is opt-in: a plain listing must not pay for it.
   */
  withStats?: boolean | undefined;
}

/* --------
 * Implementation
 * -------- */

/**
 * Full state of the configured accounts, in a single read.
 *
 * The per-account measurements are independent and are collected in parallel: across five accounts the
 * difference between sequential and parallel is the difference between a screen that appears and one
 * you wait for.
 */
export async function loadOverview(options: LoadOverviewOptions = {}): Promise<AccountOverview[]> {
  const [config, state] = await Promise.all([readConfigOrEmpty(), readMirrorState()]);

  return Promise.all(config.accounts.map(async (account) => {
    const [hasCredential, stats] = await Promise.all([
      hasCredentials(account),
      options.withStats === true && account.mirror.enabled ? readMirrorStats(account) : Promise.resolve(undefined),
    ]);

    return {
      account,
      hasCredential,
      sync: state.accounts[account.id],
      stats,
    };
  }));
}

export async function findOverview(accountId: string): Promise<AccountOverview | undefined> {
  const all = await loadOverview({ withStats: true });

  return all.find((entry) => entry.account.id === accountId);
}
