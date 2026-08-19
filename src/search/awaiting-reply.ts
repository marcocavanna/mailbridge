import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { quoteTerm } from './notmuch-query.js';

import { getNotmuchConfigPath } from '#mirror/sync';
import { parseAddressHeader } from '#shared/address';
import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';
import type { MailAddress } from '#shared/mail.types';

/* --------
 * Constants
 * -------- */

const NOTMUCH_TIMEOUT_MS = 60_000;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const DEFAULT_DAYS = 60;

const execFileAsync = promisify(execFile);

/* --------
 * Types
 * -------- */

export interface AwaitingThread {
  threadId: string;
  subject: string;
  /** Who sent the last message: the person still waiting. */
  lastFrom: MailAddress | undefined;
  lastDate: string | undefined;
  /** Days since that last message. */
  waitingDays: number;
  messageCount: number;
  /** True when the owner never wrote in this thread at all. */
  neverReplied: boolean;
  /** Folder and uid of the last message, ready to read or reply to. */
  folder: string | undefined;
  uid: number | undefined;
  messageId: string | undefined;
  /** Bulk mail, judged by the presence of `List-*` headers on the last message. */
  isBulk: boolean;
}

export interface AwaitingReplyOptions {
  /** How far back to look. Defaults to 60 days. */
  days?: number | undefined;
  /** Include newsletters and automated mail. Off by default: nobody is waiting on those. */
  includeBulk?: boolean | undefined;
  limit?: number | undefined;
}

export interface AwaitingReplyResult {
  accountId: string;
  /** Threads examined after the date filter. */
  examined: number;
  threads: AwaitingThread[];
}

/* --------
 * Types — notmuch payload
 * -------- */

interface NotmuchShowMessage {
  id?: string;
  timestamp?: number;
  filename?: string | string[];
  headers?: Record<string, string | undefined>;
}

/* --------
 * Helpers
 * -------- */

async function runNotmuch(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('notmuch', [...args], {
      timeout:   NOTMUCH_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      env:       { ...process.env, NOTMUCH_CONFIG: getNotmuchConfigPath() },
    });

    return stdout;
  } catch (cause) {
    throw new MailbridgeError('search_failed', 'Running notmuch failed.', {
      remediation: 'Check that notmuch is installed and the mirror has been synced with `mailbridge sync`.',
      cause,
    });
  }
}

/**
 * Collects the messages of one thread out of `notmuch show` output.
 *
 * The output nests threads as arrays of `[message, [replies]]`, and the nesting is what has to be kept:
 * flattening everything would lose which message belongs to which thread, and the whole question here is
 * about the *last* message of each thread.
 */
function collectThreadMessages(node: unknown, into: NotmuchShowMessage[]): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectThreadMessages(child, into);
    }

    return;
  }

  if (node === null || typeof node !== 'object') {
    return;
  }

  const candidate = node as NotmuchShowMessage;

  if (typeof candidate.id === 'string') {
    into.push(candidate);
  }
}

function firstFilename(filename: string | string[] | undefined): string | undefined {
  return typeof filename === 'string' ? filename : (Array.isArray(filename) ? filename[0] : undefined);
}

/**
 * Recovers folder and uid from a Maildir filename, so a result can be acted on over IMAP.
 *
 * The mirror keeps no uid — it does not exist in Maildir — so the folder comes from the path and the uid
 * has to be resolved separately. The path is returned here and `resolve_message` closes the gap.
 */
export function locateMessage(filename: string | undefined, accountId: string): string | undefined {
  if (filename === undefined) {
    return undefined;
  }

  const marker = `/${accountId}/`;
  const index = filename.indexOf(marker);

  if (index === -1) {
    return undefined;
  }

  const relative = filename.slice(index + marker.length);
  const segments = relative.split('/');
  const leaf = segments.findIndex((segment) => segment === 'cur' || segment === 'new');

  return leaf <= 0 ? undefined : segments.slice(0, leaf).join('/');
}

export function isBulkHeaders(headers: Record<string, string | undefined> | undefined): boolean {
  if (headers === undefined) {
    return false;
  }

  const lowered = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));

  if (lowered['list-unsubscribe'] !== undefined || lowered['list-id'] !== undefined) {
    return true;
  }

  const precedence = lowered['precedence']?.toLowerCase();

  return precedence === 'bulk' || precedence === 'list' || precedence === 'junk';
}

/* --------
 * Implementation
 * -------- */

/**
 * Finds the threads whose **last** message is not the account owner's — the conversations where somebody
 * is still waiting on them.
 *
 * The criterion matters: "no reply from me anywhere in the thread" is the wrong question, because a
 * thread where you replied and they came back afterwards still needs you. So every candidate thread is
 * examined and judged by the sender of its most recent message.
 *
 * It runs entirely on the local mirror, so it costs no IMAP round trips — but it therefore only sees mail
 * as of the last sync, and it needs the mirror to exist.
 */
export async function findAwaitingReply(
  account: Account,
  options: AwaitingReplyOptions = {},
): Promise<AwaitingReplyResult> {
  // ---- Options deconstruct
  const days = Math.max(options.days ?? DEFAULT_DAYS, 1);
  const limit = Math.max(options.limit ?? 50, 1);
  const includeBulk = options.includeBulk === true;

  if (!account.mirror.enabled) {
    throw new MailbridgeError('mirror_unavailable', `Account "${account.id}" has no local mirror.`, {
      remediation: 'This search runs on the mirror: enable it with `mailbridge account edit` and sync.',
    });
  }

  // ---- Query: threads in this account touched within the window
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
  const scope = `path:${quoteTerm(`${account.id}/**`)} and date:${since}..`;

  const raw = await runNotmuch(['show', '--format=json', '--body=false', '--entire-thread=true', scope]);

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new MailbridgeError('search_failed', 'notmuch output could not be parsed.', { cause });
  }

  if (!Array.isArray(parsed)) {
    return { accountId: account.id, examined: 0, threads: [] };
  }

  // ---- One entry per thread
  const own = account.address.toLowerCase();
  const threads: AwaitingThread[] = [];
  let examined = 0;

  for (const threadNode of parsed) {
    const messages: NotmuchShowMessage[] = [];

    collectThreadMessages(threadNode, messages);

    if (messages.length === 0) {
      continue;
    }

    examined += 1;

    messages.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));

    const last = messages[messages.length - 1];

    if (last === undefined) {
      continue;
    }

    // ---- Whose is the last word?
    const headers = last.headers ?? {};
    const fromHeader = headers['From'] ?? headers['from'];
    const lastFrom = parseAddressHeader(fromHeader)[0];

    if (lastFrom !== undefined && lastFrom.address.toLowerCase() === own) {
      continue;
    }

    const isBulk = isBulkHeaders(headers);

    if (isBulk && !includeBulk) {
      continue;
    }

    const wroteEver = messages.some((message) => {
      const address = parseAddressHeader(message.headers?.['From'] ?? message.headers?.['from'])[0];

      return address !== undefined && address.address.toLowerCase() === own;
    });

    const timestamp = last.timestamp;
    const lastDate = timestamp === undefined ? undefined : new Date(timestamp * 1000).toISOString();

    threads.push({
      threadId:     last.id ?? '',
      subject:      headers['Subject'] ?? headers['subject'] ?? '(no subject)',
      lastFrom,
      lastDate,
      waitingDays:  timestamp === undefined ? 0 : Math.floor((Date.now() / 1000 - timestamp) / 86_400),
      messageCount: messages.length,
      neverReplied: !wroteEver,
      folder:       locateMessage(firstFilename(last.filename), account.id),
      uid:          undefined,
      messageId:    last.id,
      isBulk,
    });
  }

  // ---- Longest wait first: that is the one that has gone wrong
  threads.sort((left, right) => right.waitingDays - left.waitingDays);

  logger.debug('awaiting-reply scan completed', {
    accountId: account.id,
    examined,
    found:     threads.length,
  });

  return { accountId: account.id, examined, threads: threads.slice(0, limit) };
}
