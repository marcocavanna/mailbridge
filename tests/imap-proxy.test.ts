import { connect, createServer } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { buildXoauth2, parseImapArguments, parseLogin, startImapProxy } from '#mirror/imap-proxy';

import type { Server, Socket } from 'node:net';
import type { ImapProxy } from '#mirror/imap-proxy';

/* --------
 * Fixture
 * -------- */

const account = accountSchema.parse({
  id:      'office',
  label:   'Office',
  address: 'someone@example.com',
  auth:    {
    type:     'oauth2',
    provider: 'microsoft',
    tenantId: '11111111-2222-3333-4444-555555555555',
    clientId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  },
  imap:   { host: 'outlook.office365.com', user: 'someone@example.com' },
  mirror: { enabled: true },
});

interface FakeServer {
  server: Server;
  port: number;
  received: string[];
}

/**
 * A stand-in for Exchange on loopback: greets, accepts XOAUTH2 for one token, answers CAPABILITY and
 * one SELECT. Enough to prove the hand-over, with no network beyond the machine.
 */
async function fakeExchange(acceptedToken: string): Promise<FakeServer> {
  const received: string[] = [];
  const server = createServer((socket) => {
    socket.write('* OK The Microsoft Exchange IMAP4 service is ready.\r\n');

    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      let index = buffer.indexOf('\r\n');

      while (index !== -1) {
        const line = buffer.slice(0, index);

        buffer = buffer.slice(index + 2);
        received.push(line);

        // `MB1 AUTHENTICATE XOAUTH2 <payload>`: the payload is the fourth field.
        const [tag, verb, , payload] = line.split(' ');

        if (verb === 'AUTHENTICATE') {
          socket.write(buildXoauth2('someone@example.com', acceptedToken) === payload
            ? `${tag} OK AUTHENTICATE completed.\r\n`
            : `${tag} NO AUTHENTICATE failed.\r\n`);
        } else if (verb === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4 IMAP4rev1 MOVE UIDPLUS\r\n${tag} OK CAPABILITY completed.\r\n`);
        } else if (verb === 'SELECT') {
          socket.write(`* 3 EXISTS\r\n${tag} OK [READ-WRITE] SELECT completed.\r\n`);
        }

        index = buffer.indexOf('\r\n');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();

  return { server, port: typeof address === 'object' && address !== null ? address.port : 0, received };
}

/** A client that sends lines and collects what comes back, waiting for a line that matches. */
function client(port: number): { socket: Socket; send: (line: string) => void; waitFor: (pattern: RegExp) => Promise<string[]> } {
  const socket = connect(port, '127.0.0.1');
  const lines: string[] = [];
  let buffer = '';
  let waiter: (() => void) | undefined;

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');

    let index = buffer.indexOf('\r\n');

    while (index !== -1) {
      lines.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\r\n');
    }

    waiter?.();
  });

  socket.on('close', () => waiter?.());

  return {
    socket,
    send:    (line) => socket.write(`${line}\r\n`),
    waitFor: async (pattern) => new Promise((resolve) => {
      const check = (): void => {
        if (lines.some((line) => pattern.test(line)) || socket.destroyed) {
          waiter = undefined;
          resolve([...lines]);
        }
      };

      waiter = check;
      check();
    }),
  };
}

let proxy: ImapProxy | undefined;
let exchange: FakeServer | undefined;

afterEach(async () => {
  await proxy?.close();
  exchange?.server.close();
  proxy = undefined;
  exchange = undefined;
});

async function setUp(token = 'the-token'): Promise<{ proxy: ImapProxy; exchange: FakeServer; getAccessToken: ReturnType<typeof vi.fn> }> {
  exchange = await fakeExchange('the-token');

  const port = exchange.port;
  const getAccessToken = vi.fn(async () => token);

  proxy = await startImapProxy({ account, getAccessToken, connectUpstream: () => connect(port, '127.0.0.1') });

  return { proxy, exchange, getAccessToken };
}

/* --------
 * Parsing
 * -------- */

describe('login parsing', () => {
  it('reads quoted strings with escapes and plain atoms', () => {
    expect(parseImapArguments('"some\\"one@example.com" abc123')).toEqual(['some"one@example.com', 'abc123']);
  });

  it('refuses literals, which the proxy never announces', () => {
    expect(parseLogin('{19}')).toBeUndefined();
  });

  it('refuses anything but exactly two arguments', () => {
    expect(parseLogin('"only-one"')).toBeUndefined();
    expect(parseLogin('a b c')).toBeUndefined();
  });

  it('builds the XOAUTH2 response in the documented shape', () => {
    expect(Buffer.from(buildXoauth2('u@example.com', 'tok'), 'base64').toString('utf8'))
      .toBe('user=u@example.com\x01auth=Bearer tok\x01\x01');
  });
});

/* --------
 * Behaviour
 * -------- */

describe('loopback proxy', () => {
  it('listens on loopback and announces neither LOGINDISABLED nor a SASL mechanism', async () => {
    const { proxy: started } = await setUp();
    const session = client(started.endpoint.port);

    const lines = await session.waitFor(/^\* OK/);

    expect(started.endpoint.host).toBe('127.0.0.1');
    expect(lines[0]).toMatch(/^\* OK \[CAPABILITY IMAP4rev1 ID\]/);
    expect(lines[0]).not.toMatch(/LOGINDISABLED|AUTH=/);
    session.socket.destroy();
  });

  it('refuses a wrong password, closes the connection and never asks for a token', async () => {
    const { proxy: started, getAccessToken } = await setUp();
    const session = client(started.endpoint.port);

    session.send('1 LOGIN "someone@example.com" "guess"');

    const lines = await session.waitFor(/^1 NO/);

    expect(lines).toContain('1 NO [AUTHENTICATIONFAILED] invalid credentials');
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('refuses the right password for another user', async () => {
    const { proxy: started } = await setUp();
    const session = client(started.endpoint.port);

    session.send(`1 LOGIN "intruder@example.com" "${started.endpoint.password}"`);

    expect(await session.waitFor(/^1 NO/)).toContain('1 NO [AUTHENTICATIONFAILED] invalid credentials');
  });

  it('logs in upstream with XOAUTH2, reports the server capabilities, then pipes', async () => {
    const { proxy: started, exchange: upstream } = await setUp();
    const session = client(started.endpoint.port);

    session.send(`1 LOGIN "someone@example.com" "${started.endpoint.password}"`);

    const afterLogin = await session.waitFor(/^1 OK/);

    expect(afterLogin).toContain('1 OK [CAPABILITY IMAP4 IMAP4rev1 MOVE UIDPLUS] LOGIN completed');
    expect(upstream.received[0]).toBe(`MB1 AUTHENTICATE XOAUTH2 ${buildXoauth2('someone@example.com', 'the-token')}`);

    session.send('2 SELECT INBOX');

    expect(await session.waitFor(/^2 OK/)).toContain('2 OK [READ-WRITE] SELECT completed.');
    expect(upstream.received).toContain('2 SELECT INBOX');
    session.socket.destroy();
  });

  it('turns an upstream refusal into NO with the reason, not a silent hang', async () => {
    const { proxy: started } = await setUp('a-revoked-token');
    const session = client(started.endpoint.port);

    session.send(`1 LOGIN "someone@example.com" "${started.endpoint.password}"`);

    const lines = await session.waitFor(/^1 NO/);

    expect(lines.find((line) => line.startsWith('1 NO'))).toMatch(/refused the OAuth login.*mailbridge account login office/);
  });

  it('answers only LOGIN-related commands before authentication', async () => {
    const { proxy: started } = await setUp();
    const session = client(started.endpoint.port);

    session.send('1 SELECT INBOX');

    expect(await session.waitFor(/^1 BAD/)).toContain('1 BAD only LOGIN is available before authentication');
    session.socket.destroy();
  });
});
