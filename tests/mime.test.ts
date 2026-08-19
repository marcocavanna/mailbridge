import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { simpleParser } from 'mailparser';
import { beforeAll, describe, expect, it } from 'vitest';

import { mapAddresses, parseAddressHeader } from '#shared/address';

import type { ParsedMail } from 'mailparser';

/* --------
 * Fixture
 * -------- */

let parsed: ParsedMail;

beforeAll(async () => {
  const raw = await readFile(join(import.meta.dirname, 'fixtures', 'messy-message.eml'));

  parsed = await simpleParser(raw);
});

/* --------
 * Parsing
 * -------- */

/*
 * The fixture deliberately carries non-ASCII, non-English text: accented characters and UTF-8
 * encoded-words are exactly what breaks parsers written against clean English samples. Translating it
 * would remove the thing it tests.
 */
describe('parsing a real, messy message', () => {
  it('decodes a subject with UTF-8 encoded words', () => {
    expect(parsed.subject).toBe('Re: Quote n° 42 — perché così?');
  });

  it('decodes the quoted-printable body, accents and currency symbol included', () => {
    expect(parsed.text).toContain('€ 1.240,50');
    expect(parsed.text).toContain('The total è');
  });

  it('extracts the sender, keeping name and address apart', () => {
    expect(mapAddresses(parsed.from?.value)).toEqual([
      { name: 'Rossi, Mario', address: 'mario.rossi@example.com' },
    ]);
  });

  it('flattens an address group in the recipients', () => {
    const to = mapAddresses(parsed.to === undefined ? undefined : [parsed.to].flat().flatMap((entry) => entry.value));

    expect(to.map((entry) => entry.address)).toEqual([
      'owner@example.com',
      'books@example.com',
      'payroll@example.com',
    ]);
  });

  it('decodes a non-ASCII name in cc', () => {
    expect(mapAddresses(parsed.cc === undefined ? undefined : [parsed.cc].flat().flatMap((entry) => entry.value)))
      .toEqual([{ name: 'Luisa Più', address: 'luisa@example.com' }]);
  });

  it('preserves the threading chain', () => {
    expect(parsed.messageId).toBe('<messy-case-001@example.com>');
    expect(parsed.inReplyTo).toBe('<previous-000@example.com>');
    expect([parsed.references].flat()).toContain('<root@example.com>');
  });

  it('recognizes the attachment whose name contains spaces', () => {
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('summer summary.csv');
    expect(parsed.attachments[0]?.contentType).toBe('text/csv');
  });
});

/* --------
 * Address headers
 * -------- */

describe('parseAddressHeader', () => {
  it('handles a list with quoted names containing commas', () => {
    const parsedHeader = parseAddressHeader('"Rossi, Mario" <m@x.it>, other@y.it');

    expect(parsedHeader).toEqual([
      { name: 'Rossi, Mario', address: 'm@x.it' },
      { name: undefined, address: 'other@y.it' },
    ]);
  });

  it('flattens groups', () => {
    expect(parseAddressHeader('team: a@x.it, b@x.it;').map((entry) => entry.address)).toEqual(['a@x.it', 'b@x.it']);
  });

  it('returns an empty list for an absent header', () => {
    expect(parseAddressHeader(undefined)).toEqual([]);
  });

  it('drops entries without an address instead of producing empty ones', () => {
    expect(parseAddressHeader('Name Without Address')).toEqual([]);
  });
});
