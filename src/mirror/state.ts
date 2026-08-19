import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { resolveConfigPath } from '#config/load-accounts';
import { logger } from '#shared/logger';

/* --------
 * Types
 * -------- */

export interface AccountSyncState {
  lastSyncAt: string;
  lastSyncOk: boolean;
  /** Messages indexed on the last run, to tell at a glance whether a sync did anything. */
  indexedMessages: number | undefined;
}

export interface MirrorState {
  version: 1;
  accounts: Record<string, AccountSyncState>;
}

/* --------
 * Constants
 * -------- */

const EMPTY_STATE: MirrorState = { version: 1, accounts: {} };

/* --------
 * Helpers
 * -------- */

function resolveStatePath(): string {
  return join(dirname(resolveConfigPath()), 'sync-state.json');
}

/* --------
 * Implementation
 * -------- */

/**
 * Sync state. A missing file is not an error: it means nothing has ever been synced.
 */
export async function readMirrorState(): Promise<MirrorState> {
  try {
    const raw = await readFile(resolveStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as MirrorState;

    return parsed.accounts === undefined ? EMPTY_STATE : parsed;
  } catch {
    return EMPTY_STATE;
  }
}

export async function recordSync(accountId: string, entry: AccountSyncState): Promise<void> {
  const path = resolveStatePath();
  const state = await readMirrorState();

  state.accounts[accountId] = entry;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  logger.debug('mirror state updated', { accountId, lastSyncOk: entry.lastSyncOk });
}

/**
 * Age of the oldest sync among the given accounts, in minutes. `undefined` if any of them has never
 * been synced — which is exactly the case where mirror search must not be used.
 */
export function computeStalenessMinutes(state: MirrorState, accountIds: readonly string[]): number | undefined {
  const now = Date.now();
  let worst = 0;

  for (const accountId of accountIds) {
    const entry = state.accounts[accountId];

    if (entry === undefined) {
      return undefined;
    }

    const age = (now - new Date(entry.lastSyncAt).getTime()) / 60_000;

    worst = Math.max(worst, age);
  }

  return worst;
}
