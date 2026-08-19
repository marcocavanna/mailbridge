import { homedir } from 'node:os';

import colors from 'picocolors';

/* --------
 * Types
 * -------- */

export type StatusTone = 'ok' | 'warn' | 'fail' | 'muted';

export interface TableColumn<TRow> {
  header: string;
  /** Cell content, already formatted. Width is measured on the text without ANSI codes. */
  value: (row: TRow) => string;
  align?: 'left' | 'right';
}

/* --------
 * Constants
 * -------- */

/**
 * ANSI sequences take up zero columns on screen but count towards the string's `length`: without
 * stripping them, every coloured column throws off the table's alignment.
 */
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

const GLYPHS: Record<StatusTone, string> = {
  ok:    '\u25CF',
  warn:  '\u25B2',
  fail:  '\u2715',
  muted: '\u25CB',
};

/* --------
 * Helpers
 * -------- */

function visibleLength(value: string): number {
  return value.replace(ANSI_PATTERN, '').length;
}

function padCell(value: string, width: number, align: 'left' | 'right'): string {
  const padding = ' '.repeat(Math.max(0, width - visibleLength(value)));

  return align === 'right' ? `${padding}${value}` : `${value}${padding}`;
}

/* --------
 * Formatters
 * -------- */

export function tone(value: string, status: StatusTone): string {
  switch (status) {
    case 'ok':
      return colors.green(value);
    case 'warn':
      return colors.yellow(value);
    case 'fail':
      return colors.red(value);
    case 'muted':
      return colors.dim(value);
  }
}

/**
 * A coloured glyph plus a label. The glyph carries the information even without colour, for terminals
 * that do not render it and for readers who cannot tell green from red.
 */
export function badge(text: string, status: StatusTone): string {
  return `${tone(GLYPHS[status], status)} ${text}`;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return colors.dim('n/a');
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  const decimals = unit === 0 || value >= 100 ? 0 : 1;

  return `${value.toFixed(decimals)} ${units[unit] ?? 'B'}`;
}

export function formatCount(value: number | undefined): string {
  return value === undefined ? colors.dim('n/a') : value.toLocaleString('en-US');
}

/**
 * The age of an instant in readable form. `undefined` becomes "never", which in the mirror's domain is
 * precise information rather than missing data.
 */
export function formatAge(isoDate: string | undefined): string {
  if (isoDate === undefined) {
    return colors.dim('never');
  }

  const elapsedMinutes = Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000);

  if (Number.isNaN(elapsedMinutes)) {
    return colors.dim('invalid date');
  }

  if (elapsedMinutes < 1) {
    return 'just now';
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`;
  }

  const hours = Math.round(elapsedMinutes / 60);

  if (hours < 24) {
    return `${hours} h ago`;
  }

  return `${Math.round(hours / 24)} d ago`;
}

/**
 * Shortens the home directory to `~`. A long absolute path in the middle of a table is noise that
 * hides the information, and `~/Mail` reads better than `/Users/name/Mail`.
 */
export function formatPath(path: string): string {
  const home = homedir();

  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) {
    return colors.dim('n/a');
  }

  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(1)} s`;
}

/* --------
 * Blocks
 * -------- */

export function heading(text: string): string {
  return colors.bold(text);
}

export function label(text: string, value: string): string {
  return `${colors.dim(`${text}:`)} ${value}`;
}

/**
 * A table with aligned columns. No dependency: control over alignment in the presence of colour has to
 * live here, not in a library that strips ANSI differently.
 */
export function table<TRow>(rows: readonly TRow[], columns: readonly TableColumn<TRow>[]): string {
  if (rows.length === 0) {
    return colors.dim('  no entries');
  }

  const cells = rows.map((row) => columns.map((column) => column.value(row)));

  const widths = columns.map((column, index) => Math.max(
    visibleLength(column.header),
    ...cells.map((rowCells) => visibleLength(rowCells[index] ?? '')),
  ));

  const header = columns
    .map((column, index) => colors.dim(padCell(column.header, widths[index] ?? 0, column.align ?? 'left')))
    .join('  ');

  const separator = colors.dim(widths.map((width) => '\u2500'.repeat(width)).join('  '));

  const body = cells.map((rowCells) => columns
    .map((column, index) => padCell(rowCells[index] ?? '', widths[index] ?? 0, column.align ?? 'left'))
    .join('  '));

  return [`  ${header}`, `  ${separator}`, ...body.map((line) => `  ${line}`)].join('\n');
}

/**
 * An aligned key/value block, for the detail view of a single entity.
 */
export function definitionList(entries: readonly (readonly [string, string])[]): string {
  const width = Math.max(...entries.map(([key]) => key.length));

  return entries
    .map(([key, value]) => `  ${colors.dim(key.padEnd(width))}  ${value}`)
    .join('\n');
}

export { colors };
