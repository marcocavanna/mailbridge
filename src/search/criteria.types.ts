/* --------
 * Types
 * -------- */

/**
 * Search criteria, independent of the engine. Both notmuch and IMAP SEARCH translate them into their
 * own dialect; whatever they cannot express is filtered afterwards.
 */
export interface SearchCriteria {
  /** Restrict to one account. Absent = all of them. */
  accountId?: string | undefined;
  /** Restrict to one folder (full IMAP path). */
  folder?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  /** Free text across the whole message, body included. */
  text?: string | undefined;
  /** ISO date, inclusive. */
  since?: string | undefined;
  /** ISO date, exclusive. */
  before?: string | undefined;
  isUnread?: boolean | undefined;
  isFlagged?: boolean | undefined;
  hasAttachment?: boolean | undefined;
  limit: number;
}

export type SearchEngine = 'notmuch' | 'imap';

export interface SearchDiagnostics {
  engine: SearchEngine;
  /** The query actually executed: it tells the user why a result is missing. */
  query: string;
  /** Why notmuch was not used, when IMAP was. */
  fallbackReason?: string | undefined;
}
