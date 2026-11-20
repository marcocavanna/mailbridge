import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';

import { resolveImapAuth } from '#secrets/imap-auth';
import { getSmtpPassword, hasCredentials, missingCredentialRemediation } from '#secrets/keychain';
import { describeUnknownError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const PROBE_TIMEOUT_MS = 15_000;

/* --------
 * Types
 * -------- */

export type ProbeStatus = 'ok' | 'failed' | 'skipped';

export interface ProbeResult {
  status: ProbeStatus;
  /** Why it failed, or why it was skipped. Never the credential. */
  detail: string | undefined;
  elapsedMs: number | undefined;
}

export interface AccountHealth {
  accountId: string;
  credential: ProbeStatus;
  imap: ProbeResult;
  smtp: ProbeResult;
  /** Folders seen, when the IMAP connection succeeded. */
  folderCount: number | undefined;
}

/* --------
 * Helpers
 * -------- */

function skipped(reason: string): ProbeResult {
  return { status: 'skipped', detail: reason, elapsedMs: undefined };
}

/**
 * Probes IMAP with a **dedicated** connection, not the pooled one: a test has to prove that
 * connecting from scratch works, not that a connection happens to be open already.
 */
async function probeImap(account: Account): Promise<{ probe: ProbeResult; folderCount: number | undefined }> {
  const startedAt = Date.now();

  let client: ImapFlow | undefined;

  try {
    client = new ImapFlow({
      host:   account.imap.host,
      port:   account.imap.port,
      secure: account.imap.secure,
      auth:   await resolveImapAuth(account),
      connectionTimeout: PROBE_TIMEOUT_MS,
      greetingTimeout:   PROBE_TIMEOUT_MS,
      socketTimeout:     PROBE_TIMEOUT_MS,
      logger: false,
    });

    // imapflow emits 'error' even after a clean logout: without a listener it becomes unhandled.
    client.on('error', () => undefined);

    await client.connect();

    const folders = await client.list();

    return {
      probe:       { status: 'ok', detail: undefined, elapsedMs: Date.now() - startedAt },
      folderCount: folders.length,
    };
  } catch (cause) {
    return {
      probe:       { status: 'failed', detail: describeUnknownError(cause), elapsedMs: Date.now() - startedAt },
      folderCount: undefined,
    };
  } finally {
    if (client !== undefined) {
      await client.logout().catch(() => undefined);
    }
  }
}

/**
 * Probes SMTP with `verify()`: it opens the connection, negotiates TLS and authenticates, without
 * sending anything.
 */
async function probeSmtp(account: Account): Promise<ProbeResult> {
  // ---- Validation
  const { smtp } = account;

  if (smtp === undefined) {
    return skipped('no SMTP configured: this account prepares drafts and sends nothing');
  }

  const startedAt = Date.now();

  const transporter = createTransport({
    host:   smtp.host,
    port:   smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth:   {
      user: smtp.user ?? account.imap.user,
      pass: await getSmtpPassword(account),
    },
    connectionTimeout: PROBE_TIMEOUT_MS,
    greetingTimeout:   PROBE_TIMEOUT_MS,
    socketTimeout:     PROBE_TIMEOUT_MS,
  });

  try {
    await transporter.verify();

    return { status: 'ok', detail: undefined, elapsedMs: Date.now() - startedAt };
  } catch (cause) {
    return { status: 'failed', detail: describeUnknownError(cause), elapsedMs: Date.now() - startedAt };
  } finally {
    transporter.close();
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * Probes an account's credential, IMAP and SMTP. Sends nothing and modifies nothing.
 */
export async function checkAccountHealth(account: Account): Promise<AccountHealth> {
  // ---- Credential first: without it the other probes are meaningless
  const hasCredential = await hasCredentials(account);

  if (!hasCredential) {
    const reason = `credential missing from the Keychain. ${missingCredentialRemediation(account)}`;

    return {
      accountId:   account.id,
      credential:  'failed',
      imap:        skipped(reason),
      smtp:        skipped(reason),
      folderCount: undefined,
    };
  }

  const { probe: imap, folderCount } = await probeImap(account);
  const smtp = await probeSmtp(account);

  logger.debug('health check completed', {
    accountId: account.id,
    imap:      imap.status,
    smtp:      smtp.status,
  });

  return { accountId: account.id, credential: 'ok', imap, smtp, folderCount };
}
