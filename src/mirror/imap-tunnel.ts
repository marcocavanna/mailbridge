import { connect as connectTls } from 'node:tls';

import { MailbridgeError, describeUnknownError } from '#shared/errors';
import { logger } from '#shared/logger';

import type { Duplex, Readable, Writable } from 'node:stream';
import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const UPSTREAM_TIMEOUT_MS = 20_000;

/* --------
 * Types
 * -------- */

export interface ImapTunnelOptions {
  account: Account;
  /** A valid access token. Called once, before connecting. */
  getAccessToken: () => Promise<string>;
  /** What mbsync writes: its end of the pipe, our stdin. */
  input: Readable;
  /** What mbsync reads: our stdout. Nothing but IMAP may ever be written here. */
  output: Writable;
  /** The connection to the real server. Tests replace it; by default implicit TLS to `imap.host`. */
  connectUpstream?: (account: Account) => Duplex;
}

/* --------
 * Helpers
 * -------- */

/** XOAUTH2 initial response, as Microsoft documents it: user, bearer token, two ^A terminators. */
export function buildXoauth2(user: string, accessToken: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64');
}

function defaultUpstream(account: Account): Duplex {
  // Certificate verification is Node's default and stays on: see `.claude/rules/security.md` §6.
  return connectTls({ host: account.imap.host, port: account.imap.port, servername: account.imap.host });
}

/**
 * Reads lines from the server until `isDone` says the exchange is over, then stops listening and hands
 * back whatever arrived after the last line, which belongs to whoever reads next.
 */
async function readUntil(
  socket: Duplex,
  isDone: (line: string) => boolean,
  onLine: (line: string) => void = () => undefined,
): Promise<{ last: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      reject(new MailbridgeError('imap_connection_failed', 'The mail server did not answer in time.'));
    }, UPSTREAM_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);

      let index = buffer.indexOf('\r\n');

      while (index !== -1) {
        const line = buffer.subarray(0, index).toString('utf8');

        buffer = buffer.subarray(index + 2);
        onLine(line);

        if (isDone(line)) {
          cleanup();
          resolve({ last: line, rest: buffer });

          return;
        }

        index = buffer.indexOf('\r\n');
      }
    };

    const onEnd = (): void => {
      cleanup();
      reject(new MailbridgeError('imap_connection_failed', 'The mail server closed the connection during login.'));
    };

    const onError = (cause: Error): void => {
      cleanup();
      reject(new MailbridgeError('imap_connection_failed', 'The connection to the mail server failed.', { cause }));
    };

    function cleanup(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    }

    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

/**
 * Opens the real connection and authenticates it with XOAUTH2. Returns the socket, the capabilities the
 * server announces after login, and any bytes that arrived past the last response.
 */
async function openUpstream(
  options: ImapTunnelOptions,
): Promise<{ upstream: Duplex; capability: string; rest: Buffer }> {
  const { account } = options;

  // ---- Credentials first: no point connecting without a token
  const accessToken = await options.getAccessToken();
  const upstream = (options.connectUpstream ?? defaultUpstream)(account);

  // A listener for the whole life of the socket: between one read and the next nobody else listens, and
  // an unhandled 'error' would take the process down with it.
  upstream.on('error', () => undefined);

  try {
    // ---- Greeting
    const greeting = await readUntil(upstream, () => true);

    if (!greeting.last.startsWith('* OK')) {
      throw new MailbridgeError('imap_connection_failed', 'The mail server refused the connection.');
    }

    // ---- Authenticate
    upstream.write(`MB1 AUTHENTICATE XOAUTH2 ${buildXoauth2(account.imap.user, accessToken)}\r\n`);

    const auth = await readUntil(upstream, (line) => {
      if (line.startsWith('+')) {
        // A continuation here carries the server's error: an empty line closes the exchange with NO.
        upstream.write('\r\n');

        return false;
      }

      return line.startsWith('MB1 ');
    });

    if (!auth.last.startsWith('MB1 OK')) {
      throw new MailbridgeError('credential_rejected', `The mail server refused the OAuth login: ${auth.last.slice(4)}`, {
        remediation: `Sign in again with \`mailbridge account login ${account.id}\`.`,
      });
    }

    // ---- Capabilities after login, which are the ones mbsync has to see
    let capability = '';

    upstream.write('MB2 CAPABILITY\r\n');

    const caps = await readUntil(upstream, (line) => line.startsWith('MB2 '), (line) => {
      if (line.startsWith('* CAPABILITY ')) {
        capability = line.slice('* CAPABILITY '.length);
      }
    });

    return { upstream, capability, rest: caps.rest };
  } catch (cause) {
    upstream.destroy();

    throw cause;
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * The IMAP tunnel mbsync runs for an OAuth account (`Tunnel` in the generated `mbsyncrc`).
 *
 * mbsync speaks IMAP on this process's stdin and stdout. The tunnel logs in to the real server with SASL
 * XOAUTH2, then greets mbsync with `* PREAUTH`, which tells it the session is already authenticated:
 * mbsync sends no LOGIN and needs no password. From then on the tunnel copies bytes both ways without
 * reading them.
 *
 * Nothing listens anywhere and no secret exists outside this process: the pipe is private to mbsync and
 * its child, and the token stays in memory. That is the whole reason for this shape over a loopback
 * proxy, which an audit found reachable by any local process and parsing hostile input before login.
 *
 * Why at all: mbsync authenticates through the system `libsasl2`, which on macOS has no XOAUTH2 plugin,
 * and Exchange Online offers nothing else.
 */
export async function runImapTunnel(options: ImapTunnelOptions): Promise<void> {
  const { account, input, output } = options;

  // Nothing mbsync sends before the greeting is lost: it waits in the stream until the pipe is set.
  input.pause();

  let session: Awaited<ReturnType<typeof openUpstream>>;

  try {
    session = await openUpstream(options);
  } catch (cause) {
    // mbsync reads a BYE greeting as a refused connection and reports it; the reason also goes to
    // stderr, which mailbridge captures in the sync detail.
    const reason = describeUnknownError(cause).replace(/[\r\n]+/g, ' ');

    output.write(`* BYE ${reason}\r\n`);

    throw cause;
  }

  const { upstream, capability, rest } = session;

  // ---- Hand over: from here on the tunnel is a pipe and reads nothing
  output.write(`* PREAUTH [CAPABILITY ${capability}] mailbridge tunnel to ${account.imap.host}\r\n`);

  if (rest.length > 0) {
    output.write(rest);
  }

  logger.debug('IMAP tunnel open', { accountId: account.id });

  await new Promise<void>((resolve) => {
    let isDone = false;

    const finish = (): void => {
      if (isDone) {
        return;
      }

      isDone = true;
      upstream.destroy();
      input.destroy();
      output.end(() => resolve());
    };

    // `pipe` and not hand-written writes: it pauses the faster side when the slower one is full, so a
    // large message from the server never piles up in memory while mbsync writes it to disk.
    upstream.pipe(output, { end: false });
    input.pipe(upstream);

    // mbsync closing its side ends the session (`pipe` ends the upstream); the server closing ends it too.
    input.once('error', finish);
    output.once('error', finish);
    upstream.once('close', finish);
  });
}
