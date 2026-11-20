import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import { connect as connectTls } from 'node:tls';

import { MailbridgeError, describeUnknownError } from '#shared/errors';
import { logger, registerSecret } from '#shared/logger';

import type { Server, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Account } from '#config/accounts.schema';

/* --------
 * Constants
 * -------- */

const LOOPBACK = '127.0.0.1';

/** A client that does not log in within this time is dropped: mbsync logs in right away. */
const PRE_AUTH_TIMEOUT_MS = 30_000;

const UPSTREAM_TIMEOUT_MS = 20_000;

/** Longer lines before login are not IMAP from mbsync: the connection is closed. */
const MAX_PRE_AUTH_LINE = 4096;

/**
 * What the proxy announces before login. Deliberately minimal: no `LOGINDISABLED`, which would stop
 * mbsync from sending `LOGIN`, no `AUTH=`, which would send it into the system SASL library, and no
 * `LITERAL+`, which keeps the login arguments on one line.
 */
const PRE_AUTH_CAPABILITY = 'IMAP4rev1 ID';

/* --------
 * Types
 * -------- */

export interface ProxyEndpoint {
  host: string;
  port: number;
  /** One-time password for this proxy only, written into the generated `mbsyncrc`. */
  password: string;
}

export interface ImapProxy {
  endpoint: ProxyEndpoint;
  close: () => Promise<void>;
}

export interface StartImapProxyOptions {
  account: Account;
  /** A valid access token, renewed by the caller when needed. Called on every login. */
  getAccessToken: () => Promise<string>;
  /** The connection to the real server. Tests replace it; by default implicit TLS to `imap.host`. */
  connectUpstream?: (account: Account) => Duplex;
}

export type LoginArguments = { user: string; password: string } | undefined;

/* --------
 * Parsing
 * -------- */

/**
 * Splits the arguments of an IMAP command into atoms and quoted strings (RFC 3501 §4.3). Literals are
 * not accepted: the proxy does not announce `LITERAL+`, and mbsync sends short credentials quoted.
 */
export function parseImapArguments(input: string): string[] | undefined {
  const values: string[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];

    if (char === ' ') {
      index += 1;
      continue;
    }

    if (char === '{') {
      return undefined;
    }

    if (char === '"') {
      let value = '';

      index += 1;

      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\') {
          index += 1;
        }

        value += input[index] ?? '';
        index += 1;
      }

      if (index >= input.length) {
        return undefined;
      }

      values.push(value);
      index += 1;
      continue;
    }

    const end = input.indexOf(' ', index);
    const atom = end === -1 ? input.slice(index) : input.slice(index, end);

    values.push(atom);
    index = end === -1 ? input.length : end;
  }

  return values;
}

export function parseLogin(argumentsText: string): LoginArguments {
  const values = parseImapArguments(argumentsText);

  if (values?.length !== 2 || values[0] === undefined || values[1] === undefined) {
    return undefined;
  }

  return { user: values[0], password: values[1] };
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}

/** XOAUTH2 initial response, as Microsoft documents it: user, bearer token, two ^A terminators. */
export function buildXoauth2(user: string, accessToken: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64');
}

/* --------
 * Upstream
 * -------- */

function defaultUpstream(account: Account): Duplex {
  return connectTls({ host: account.imap.host, port: account.imap.port, servername: account.imap.host });
}

/**
 * Reads lines from a socket until `isDone` says the exchange is over, then stops listening and hands
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
 * Opens the real connection and authenticates it with XOAUTH2. Returns the socket, the capabilities
 * the server announces after login, and any bytes that arrived past the last response.
 */
async function openUpstream(
  options: StartImapProxyOptions,
): Promise<{ upstream: Duplex; capability: string; rest: Buffer }> {
  const { account } = options;

  // ---- Credentials first: no point connecting without a token
  const accessToken = await options.getAccessToken();
  const upstream = (options.connectUpstream ?? defaultUpstream)(account);

  // A listener for the whole life of the socket: between one read and the next nobody else listens, and
  // an unhandled 'error' would take the sync process down with it.
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
 * Client side
 * -------- */

function handleClient(client: Socket, options: StartImapProxyOptions, password: string): void {
  const { account } = options;

  let buffer = '';
  let isHandingOver = false;

  client.setTimeout(PRE_AUTH_TIMEOUT_MS, () => client.destroy());
  client.on('error', () => client.destroy());
  client.write(`* OK [CAPABILITY ${PRE_AUTH_CAPABILITY}] mailbridge loopback proxy ready\r\n`);

  const onData = (chunk: Buffer): void => {
    if (isHandingOver) {
      return;
    }

    buffer += chunk.toString('utf8');

    if (buffer.length > MAX_PRE_AUTH_LINE && !buffer.includes('\r\n')) {
      client.destroy();

      return;
    }

    let index = buffer.indexOf('\r\n');

    while (index !== -1 && !isHandingOver) {
      const line = buffer.slice(0, index);

      buffer = buffer.slice(index + 2);
      handleLine(line);
      index = buffer.indexOf('\r\n');
    }
  };

  const handleLine = (line: string): void => {
    const firstSpace = line.indexOf(' ');
    const tag = firstSpace === -1 ? line : line.slice(0, firstSpace);
    const remainder = firstSpace === -1 ? '' : line.slice(firstSpace + 1);
    const secondSpace = remainder.indexOf(' ');
    const verb = (secondSpace === -1 ? remainder : remainder.slice(0, secondSpace)).toUpperCase();
    const argumentsText = secondSpace === -1 ? '' : remainder.slice(secondSpace + 1);

    switch (verb) {
      case 'CAPABILITY':
        client.write(`* CAPABILITY ${PRE_AUTH_CAPABILITY}\r\n${tag} OK CAPABILITY completed\r\n`);

        return;
      case 'NOOP':
        client.write(`${tag} OK NOOP completed\r\n`);

        return;
      case 'ID':
        client.write(`* ID NIL\r\n${tag} OK ID completed\r\n`);

        return;
      case 'LOGOUT':
        client.end(`* BYE logging out\r\n${tag} OK LOGOUT completed\r\n`);

        return;
      case 'LOGIN':
        login(tag, argumentsText);

        return;
      default:
        client.write(`${tag} BAD only LOGIN is available before authentication\r\n`);
    }
  };

  const login = (tag: string, argumentsText: string): void => {
    const credentials = parseLogin(argumentsText);

    // One attempt per connection: the password is random and one-time, so a wrong one is never a
    // typo, and there is no reason to let anyone try again on the same connection.
    if (
      credentials === undefined
      || credentials.user.toLowerCase() !== account.imap.user.toLowerCase()
      || !sameSecret(credentials.password, password)
    ) {
      logger.warn('loopback proxy refused a login', { accountId: account.id });
      client.end(`${tag} NO [AUTHENTICATIONFAILED] invalid credentials\r\n`);

      return;
    }

    isHandingOver = true;
    client.off('data', onData);
    client.pause();

    const pending = Buffer.from(buffer, 'utf8');

    void (async () => {
      try {
        const { upstream, capability, rest } = await openUpstream(options);

        // ---- Hand over: from here on the proxy is a pipe and reads nothing
        client.setTimeout(0);
        client.write(`${tag} OK [CAPABILITY ${capability}] LOGIN completed\r\n`);

        if (rest.length > 0) {
          client.write(rest);
        }

        if (pending.length > 0) {
          upstream.write(pending);
        }

        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();

        upstream.on('error', () => client.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      } catch (cause) {
        logger.warn('loopback proxy could not log in upstream', { accountId: account.id, error: describeUnknownError(cause) });
        client.end(`${tag} NO [AUTHENTICATIONFAILED] ${describeUnknownError(cause).replace(/[\r\n]+/g, ' ')}\r\n`);
      }
    })();
  };

  client.on('data', onData);
}

/* --------
 * Implementation
 * -------- */

/**
 * Starts an IMAP proxy on the loopback interface, so `mbsync` can mirror an account that only accepts
 * OAuth: mbsync logs in to the proxy with `LOGIN` and a one-time password, the proxy logs in to the real
 * server with SASL XOAUTH2 and from then on copies bytes in both directions without reading them.
 *
 * Plain text between mbsync and the proxy is a deliberate exception to TLS everywhere
 * (`.claude/rules/security.md` §6): the traffic never leaves the kernel, the password is random, valid
 * for this proxy only and dead when the sync ends, and reading loopback traffic needs root, which can
 * read the Keychain anyway. The leg that crosses the network is TLS with certificate verification.
 *
 * Why this rather than mbsync's own SASL: mbsync authenticates through the system `libsasl2`, which on
 * macOS has no XOAUTH2 plugin, and Exchange Online offers nothing else.
 */
export async function startImapProxy(options: StartImapProxyOptions): Promise<ImapProxy> {
  const password = randomBytes(32).toString('hex');

  registerSecret(password);

  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    handleClient(client, options, password);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  logger.debug('loopback proxy listening', { accountId: options.account.id, port });

  return {
    endpoint: { host: LOOPBACK, port, password },
    close:    async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
