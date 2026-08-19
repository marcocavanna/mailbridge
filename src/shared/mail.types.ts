import type { SpecialFolder } from '#config/accounts.schema';

/* --------
 * Folders
 * -------- */

export interface Folder {
  /** Full path with the server's delimiter. This is the identifier, not the display name. */
  path: string;
  name: string;
  delimiter: string;
  /** Special role, when the server announces it or the configuration declares it. */
  specialUse: SpecialFolder | undefined;
  subscribed: boolean;
}

/* --------
 * Messages
 * -------- */

export interface MailAddress {
  name: string | undefined;
  address: string;
}

export interface Attachment {
  /** Stable index within the message: this is how a tool asks for its content. */
  index: number;
  filename: string | undefined;
  contentType: string;
  size: number;
  contentId: string | undefined;
  isInline: boolean;
}

/**
 * A message header: enough to list and decide, without downloading any bodies.
 */
export interface MessageSummary {
  accountId: string;
  folder: string;
  uid: number;
  messageId: string | undefined;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  date: string | undefined;
  size: number;
  flags: string[];
  isSeen: boolean;
  isFlagged: boolean;
  isAnswered: boolean;
  hasAttachments: boolean;
  /** First characters of the text body, when available at no extra cost. */
  preview: string | undefined;
}

/**
 * A complete message. `text` is the preferred form for reading; `html` stays available but is
 * untrusted content just as much as the rest — see `.claude/rules/security.md` §2.
 */
export interface Message extends MessageSummary {
  replyTo: MailAddress[];
  inReplyTo: string | undefined;
  references: string[];
  text: string | undefined;
  html: string | undefined;
  /**
   * Where `text` came from. `converted-html` means the sender shipped no plain-text part and the body
   * was derived from the HTML — worth stating rather than passing a conversion off as the original.
   */
  bodySource: 'text' | 'converted-html' | 'none';
  attachments: Attachment[];
}

/* --------
 * Threads
 * -------- */

export interface Thread {
  /** Message-Id of the root, when it can be identified. */
  rootMessageId: string | undefined;
  subject: string;
  messages: MessageSummary[];
}
