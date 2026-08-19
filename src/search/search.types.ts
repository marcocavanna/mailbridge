import type { MailAddress } from '#shared/mail.types';

/* --------
 * Types
 * -------- */

/**
 * A search result. Not a `MessageSummary`: a search can come from the mirror, where the IMAP uid does
 * not exist. Whoever wants to act on the message resolves it afterwards, by `messageId`.
 */
export interface SearchHit {
  accountId: string;
  folder: string | undefined;
  messageId: string | undefined;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  date: string | undefined;
  isUnread: boolean;
  isFlagged: boolean;
  hasAttachment: boolean;
  /** Present only when the result comes from IMAP. */
  uid: number | undefined;
}
