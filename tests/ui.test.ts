import { homedir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { badge, formatAge, formatBytes, formatCount, formatDuration, formatPath, table } from '../src/cli/ui.js';

/* --------
 * Helpers
 * -------- */

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

function strip(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

/* --------
 * Formatters
 * -------- */

describe('formatBytes', () => {
  it('scales the units', () => {
    expect(strip(formatBytes(512))).toBe('512 B');
    expect(strip(formatBytes(1024))).toBe('1.0 KB');
    expect(strip(formatBytes(1024 * 1024 * 3.5))).toBe('3.5 MB');
    expect(strip(formatBytes(1024 ** 3 * 12))).toBe('12.0 GB');
  });

  it('drops decimals where they would be noise', () => {
    expect(strip(formatBytes(1024 * 250))).toBe('250 KB');
  });

  it('tells zero apart from absent', () => {
    expect(strip(formatBytes(0))).toBe('0 B');
    expect(strip(formatBytes(undefined))).toBe('n/a');
  });
});

describe('formatAge', () => {
  it('says "never" for an absent instant, which in the mirror is precise information', () => {
    expect(strip(formatAge(undefined))).toBe('never');
  });

  it('picks the scale from the distance', () => {
    const minutesAgo = (count: number): string => (new Date(Date.now() - count * 60_000).toISOString());

    expect(strip(formatAge(minutesAgo(0)))).toBe('just now');
    expect(strip(formatAge(minutesAgo(12)))).toBe('12 min ago');
    expect(strip(formatAge(minutesAgo(180)))).toBe('3 h ago');
    expect(strip(formatAge(minutesAgo(60 * 24 * 3)))).toBe('3 d ago');
  });

  it('does not produce NaN from an invalid date', () => {
    expect(strip(formatAge('not-a-date'))).toBe('invalid date');
  });
});

describe('formatPath', () => {
  it('shortens the home directory to ~', () => {
    expect(formatPath(`${homedir()}/Mail/work`)).toBe('~/Mail/work');
  });

  it('shortens the home directory itself', () => {
    expect(formatPath(homedir())).toBe('~');
  });

  it('leaves a path outside the home untouched', () => {
    expect(formatPath('/Volumes/External/Mail')).toBe('/Volumes/External/Mail');
  });

  it('does not mistake a directory sharing the home prefix for the home', () => {
    expect(formatPath(`${homedir()}-backup/Mail`)).toBe(`${homedir()}-backup/Mail`);
  });
});

describe('formatCount and formatDuration', () => {
  it('groups thousands', () => {
    expect(strip(formatCount(12_345))).toBe('12,345');
  });

  it('switches to seconds past a thousand milliseconds', () => {
    expect(strip(formatDuration(430))).toBe('430 ms');
    expect(strip(formatDuration(2400))).toBe('2.4 s');
  });
});

/* --------
 * Table
 * -------- */

describe('table', () => {
  interface Row {
    id: string;
    state: string;
  }

  const rows: Row[] = [
    { id: 'short', state: badge('ok', 'ok') },
    { id: 'a-much-longer-id', state: badge('failed', 'fail') },
  ];

  /*
   * This is why the table uses no library: ANSI sequences count towards a string's `length` but take up
   * zero columns, so a coloured cell throws off alignment unless the width is measured on stripped text.
   */
  it('aligns the columns ignoring colour codes', () => {
    const rendered = table(rows, [
      { header: 'ID', value: (row) => row.id },
      { header: 'STATE', value: (row) => row.state },
    ]);

    const lines = strip(rendered).split('\n');
    const first = lines[2];
    const second = lines[3];

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // The STATE column starts at the same position on every row.
    expect(first?.indexOf('\u25CF')).toBe(second?.indexOf('\u2715'));
  });

  it('aligns right when asked to', () => {
    const rendered = strip(table(
      [{ id: 'a', state: '5' }, { id: 'b', state: '1234' }],
      [
        { header: 'ID', value: (row) => row.id },
        { header: 'N', value: (row) => row.state, align: 'right' },
      ],
    ));

    const lines = rendered.split('\n');

    expect(lines[2]?.endsWith('   5')).toBe(true);
    expect(lines[3]?.endsWith('1234')).toBe(true);
  });

  it('does not print an empty table without saying so', () => {
    expect(strip(table([], [{ header: 'ID', value: () => '' }]))).toContain('no entries');
  });
});
