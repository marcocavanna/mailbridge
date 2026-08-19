import { searchWithImap } from './imap-search.js';
import { isNotmuchAvailable, searchWithNotmuch } from './notmuch.js';

import { computeStalenessMinutes, readMirrorState } from '#mirror/state';
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
 * Runs a search, choosing the engine.
 *
 * notmuch when the mirror exists and has been synced — orders of magnitude faster, and it searches
 * message bodies. IMAP when the mirror is missing, stale past the threshold, or when the caller
 * explicitly wants fresh data. The choice is always reported in the diagnostics: a search that does
 * not explain where its results came from is a search you cannot trust.
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

  // ---- Engine choice
  const mirrored = scope.filter((account) => account.mirror.enabled);
  let fallbackReason: string | undefined;

  if (options.requireFresh === true) {
    fallbackReason = 'fresh server data explicitly requested';
  } else if (mirrored.length < scope.length) {
    fallbackReason = 'at least one account in scope has no mirror enabled';
  } else if (!(await isNotmuchAvailable())) {
    fallbackReason = 'notmuch unavailable, or the index was never built';
  } else {
    const state = await readMirrorState();
    const staleness = computeStalenessMinutes(state, mirrored.map((account) => account.id));

    if (staleness === undefined) {
      fallbackReason = 'one of the accounts has never been synced';
    } else if (staleness > STALE_AFTER_MINUTES) {
      warnings.push(
        `The mirror is ${Math.round(staleness)} minutes old: messages that arrived later do not appear. Run \`sync_now\`.`,
      );
    }
  }

  // ---- Notmuch path
  if (fallbackReason === undefined) {
    // The ids in scope let the builder qualify a folder criterion: in notmuch `folder:` is relative
    // to the database root, so `INBOX` on its own finds nothing.
    const { hits, query } = await searchWithNotmuch(criteria, {
      accountIds: scope.map((account) => account.id),
    });

    if (criteria.hasAttachment === true) {
      warnings.push('The attachment filter uses the notmuch `attachment` tag, which not every index populates.');
    }

    return { hits, diagnostics: { engine: 'notmuch', query, fallbackReason: undefined }, warnings };
  }

  // ---- IMAP path
  logger.debug('searching over IMAP', { fallbackReason, accounts: scope.length });

  const collected: SearchHit[] = [];
  const queries: string[] = [];

  for (const account of scope) {
    try {
      const { hits, query } = await searchWithImap(account, criteria);

      collected.push(...hits);
      queries.push(`${account.id}: ${query}`);
    } catch (cause) {
      warnings.push(`Search on "${account.id}" failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  // ---- Result mapping
  collected.sort((left, right) => (right.date ?? '').localeCompare(left.date ?? ''));

  return {
    hits:        collected.slice(0, criteria.limit),
    diagnostics: { engine: 'imap', query: queries.join(' | '), fallbackReason },
    warnings,
  };
}
