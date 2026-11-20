import { searchWithImap } from './imap-search.js';
import { isNotmuchAvailable } from './notmuch-exec.js';
import { searchWithNotmuch } from './notmuch.js';

import { resolveMirrorFolder } from '#mirror/paths';
import { computeStalenessMinutes, hasCompletedSync, readMirrorState } from '#mirror/state';
import { logger } from '#shared/logger';

import type { SearchCriteria, SearchDiagnostics } from './criteria.types.js';
import type { SearchHit } from './search.types.js';
import type { Account, AccountsConfig } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

/** Past this age the mirror is considered stale and the search says so. */
const STALE_AFTER_MINUTES = 30;

/* --------
 * Types
 * -------- */

export interface SearchOutcome {
  hits: SearchHit[];
  diagnostics: SearchDiagnostics;
  /** Non-blocking warnings: stale mirror, excluded account, missing capability. */
  warnings: string[];
}

export interface ExecuteSearchOptions {
  /** Force a live IMAP search, ignoring the mirror. */
  requireFresh?: boolean | undefined;
}

/* --------
 * Helpers
 * -------- */

function resolveScope(config: AccountsConfig, criteria: SearchCriteria): Account[] {
  if (criteria.accountId === undefined) {
    return config.accounts;
  }

  return config.accounts.filter((account) => account.id === criteria.accountId);
}

/* --------
 * Implementation
 * -------- */

/**
 * Runs a search, choosing the engine **account by account**.
 *
 * notmuch for the accounts whose mirror exists and has been synced: orders of magnitude faster, and it
 * searches message bodies. IMAP for the others, across every folder: an account without a mirror, one
 * never synced, one whose mirror lacks the requested folder, or any account when the caller wants fresh
 * data. One account without a mirror does not take the index away from the rest, which is what used to
 * happen when the choice was made for the whole scope at once.
 *
 * The choice is always reported in the diagnostics, per account: a search that does not explain where
 * its results came from is a search you cannot trust.
 */
export async function executeSearch(
  config: AccountsConfig,
  criteria: SearchCriteria,
  options: ExecuteSearchOptions = {},
): Promise<SearchOutcome> {
  // ---- Scope
  const scope = resolveScope(config, criteria);
  const warnings: string[] = [];

  if (scope.length === 0) {
    return {
      hits:        [],
      diagnostics: { engine: 'imap', query: '', fallbackReason: undefined },
      warnings:    [`No account matches "${criteria.accountId ?? ''}".`],
    };
  }

  // ---- Engine choice, per account
  const local: Account[] = [];
  const remote: { account: Account; reason: string }[] = [];

  const mirrored = scope.filter((account) => account.mirror.enabled);

  for (const account of scope) {
    if (!account.mirror.enabled) {
      remote.push({ account, reason: 'mirror disabled' });
    }
  }

  // Reasons that apply to every mirrored account at once.
  const sharedReason = options.requireFresh === true
    ? 'fresh server data explicitly requested'
    : mirrored.length > 0 && !(await isNotmuchAvailable())
      ? 'notmuch unavailable, or the index was never built'
      : undefined;

  if (sharedReason !== undefined) {
    remote.push(...mirrored.map((account) => ({ account, reason: sharedReason })));
  } else if (mirrored.length > 0) {
    const state = await readMirrorState();

    for (const account of mirrored) {
      if (!hasCompletedSync(state, account.id)) {
        remote.push({ account, reason: 'the mirror has never completed a sync' });
      } else {
        local.push(account);
      }
    }

    const staleness = computeStalenessMinutes(state, local.map((account) => account.id));

    if (local.length > 0 && staleness !== undefined && staleness > STALE_AFTER_MINUTES) {
      warnings.push(
        `The mirror is ${Math.round(staleness)} minutes old: messages that arrived later do not appear. Run \`sync_now\`.`,
      );
    }
  }

  // ---- Folder resolution against the mirror
  // notmuch indexes the maildir, and mbsync explodes the remote hierarchy into directories: the IMAP
  // path is not a path the index knows. An account whose mirror cannot locate the folder goes to the
  // server for that folder, rather than being answered as empty or left out.
  const mirrorFolders = new Map<string, string>();

  if (criteria.folder !== undefined) {
    for (const account of [...local]) {
      const resolved = await resolveMirrorFolder(account, criteria.folder);

      if (resolved === undefined) {
        local.splice(local.indexOf(account), 1);
        remote.push({ account, reason: `"${criteria.folder}" is not a folder of its local mirror` });
      } else {
        mirrorFolders.set(account.id, resolved);
      }
    }
  }

  // ---- Notmuch path
  const collected: SearchHit[] = [];
  const queries: string[] = [];

  if (local.length > 0) {
    // The ids scope the query to these accounts' directories: the index can hold files of accounts
    // searched over IMAP, and those must not answer twice, or at all when they are stale.
    const { hits, query } = await searchWithNotmuch(
      { ...criteria, accountId: undefined },
      { accountIds: local.map((account) => account.id), mirrorFolders },
    );

    collected.push(...hits);
    queries.push(`notmuch: ${query}`);

    if (criteria.hasAttachment === true) {
      warnings.push('The attachment filter uses the notmuch `attachment` tag, which not every index populates.');
    }
  }

  // ---- IMAP path
  if (remote.length > 0) {
    logger.debug('searching over IMAP', { accounts: remote.map((entry) => entry.account.id) });
  }

  for (const { account } of remote) {
    try {
      const { hits, query, folders, failures } = await searchWithImap(account, criteria);

      collected.push(...hits);
      queries.push(`${account.id} over IMAP, ${folders.length === 1 ? `folder ${folders[0] ?? ''}` : `${folders.length} folders`}: ${query}`);

      if (failures.length > 0) {
        warnings.push(`On "${account.id}" ${failures.length} folders could not be searched: ${failures.join('; ')}`);
      }
    } catch (cause) {
      warnings.push(`Search on "${account.id}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  // ---- Result Mapping
  collected.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));

  const engine = remote.length === 0 ? 'notmuch' : local.length === 0 ? 'imap' : 'mixed';
  const fallbackReason = remote.length === 0
    ? undefined
    : remote.map(({ account, reason }) => `${account.id}: ${reason}`).join('; ');

  return {
    hits:        collected.slice(0, criteria.limit),
    diagnostics: { engine, query: queries.join(' | '), fallbackReason },
    warnings,
  };
}
