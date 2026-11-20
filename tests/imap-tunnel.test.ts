import { connect, createServer } from 'node:net';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { accountSchema } from '#config/accounts.schema';
import { buildXoauth2, runImapTunnel } from '#mirror/imap-tunnel';

import type { Server } from 'node:net';

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
  imap: { host: 'outlook.office365.com', user: 'someone@example.com' },
});

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/**
 * A stand-in for Exchange on loopback: greets, accepts XOAUTH2 for one token, answers CAPABILITY and
 * one SELECT, and closes on LOGOUT. Enough to prove the hand-over without the network.
 */
async function fakeExchange(acceptedToken: string): Promise<{ port: number; received: string[] }> {
  const received: string[] = [];

  server = createServer((socket) => {
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
        } else if (verb === 'LOGOUT') {
          socket.end(`* BYE\r\n${tag} OK LOGOUT completed.\r\n`);
        }

        index = buffer.indexOf('\r\n');
      }
    });
  });

  await new Promise<void>((resolve) => {
    server?.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();

  return { port: typeof address === 'object' && address !== null ? address.port : 0, received };
}

function collect(stream: PassThrough): () => string {
  let text = '';

  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });

  return () => text;
}

async function waitFor(read: () => string, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 200 && !pattern.test(read()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* --------
 * Behaviour
 * -------- */

describe('IMAP tunnel for mbsync', () => {
  it('logs in upstream with XOAUTH2, greets mbsync with PREAUTH and then pipes', async () => {
    const exchange = await fakeExchange('the-token');
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);

    const done = runImapTunnel({
      account,
      getAccessToken:  async () => 'the-token',
      input,
      output,
      connectUpstream: () => connect(exchange.port, '127.0.0.1'),
    });

    await waitFor(read, /PREAUTH/);

    expect(read()).toMatch(/^\* PREAUTH \[CAPABILITY IMAP4 IMAP4rev1 MOVE UIDPLUS\] /);
    expect(exchange.received[0]).toBe(`MB1 AUTHENTICATE XOAUTH2 ${buildXoauth2('someone@example.com', 'the-token')}`);

    input.write('a1 SELECT INBOX\r\n');
    await waitFor(read, /a1 OK/);

    expect(read()).toContain('a1 OK [READ-WRITE] SELECT completed.');

    input.write('a2 LOGOUT\r\n');
    await done;

    expect(read()).toContain('a2 OK LOGOUT completed.');
  });

  it('never sends mbsync a login prompt: nothing before PREAUTH but the greeting itself', async () => {
    const exchange = await fakeExchange('the-token');
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);

    const done = runImapTunnel({
      account,
      getAccessToken:  async () => 'the-token',
      input,
      output,
      connectUpstream: () => connect(exchange.port, '127.0.0.1'),
    });

    await waitFor(read, /PREAUTH/);

    expect(read().split('\r\n')[0]).toMatch(/^\* PREAUTH /);
    expect(read()).not.toContain('the-token');

    input.end();
    await done;
  });

  it('turns an upstream refusal into BYE with the reason, and fails', async () => {
    const exchange = await fakeExchange('the-token');
    const output = new PassThrough();
    const read = collect(output);

    await expect(runImapTunnel({
      account,
      getAccessToken:  async () => 'a-revoked-token',
      input:           new PassThrough(),
      output,
      connectUpstream: () => connect(exchange.port, '127.0.0.1'),
    })).rejects.toThrow(/refused the OAuth login/);

    expect(read()).toMatch(/^\* BYE .*mailbridge account login office/);
  });

  it('does not connect at all when no token can be had', async () => {
    let connected = false;

    await expect(runImapTunnel({
      account,
      getAccessToken:  async () => {
        throw new Error('never signed in');
      },
      input:           new PassThrough(),
      output:          new PassThrough(),
      connectUpstream: () => {
        connected = true;

        return new PassThrough();
      },
    })).rejects.toThrow(/never signed in/);

    expect(connected).toBe(false);
  });
});
