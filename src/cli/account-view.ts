import {
  badge,
  colors,
  definitionList,
  formatAge,
  formatBytes,
  formatCount,
  formatDuration,
  table,
} from './ui.js';

import type { AccountOverview } from './overview.js';
import type { AccountHealth, ProbeResult } from '#imap/health';
import type { StatusTone } from './ui.js';

/* --------
 * Helpers
 * -------- */

function credentialCell(entry: AccountOverview): string {
  return entry.hasCredential ? badge('present', 'ok') : badge('missing', 'fail');
}

function mirrorCell(entry: AccountOverview): string {
  if (!entry.account.mirror.enabled) {
    return badge('disabled', 'muted');
  }

  if (entry.sync === undefined) {
    return badge('never synced', 'warn');
  }

  return entry.sync.lastSyncOk ? badge(formatAge(entry.sync.lastSyncAt), 'ok') : badge('last sync failed', 'fail');
}

function probeCell(probe: ProbeResult): string {
  switch (probe.status) {
    case 'ok':
      return badge(formatDuration(probe.elapsedMs), 'ok');
    case 'failed':
      return badge('failed', 'fail');
    case 'skipped':
      return badge('skipped', 'muted');
  }
}

/* --------
 * Views
 * -------- */

/**
 * Compact listing of the accounts. This is the default view: one row per account, no slow
 * measurements.
 */
export function renderAccountList(entries: readonly AccountOverview[]): string {
  return table(entries, [
    { header: 'ID', value: (entry) => colors.bold(entry.account.id) },
    { header: 'ADDRESS', value: (entry) => entry.account.address },
    { header: 'IMAP', value: (entry) => `${entry.account.imap.host}:${entry.account.imap.port}` },
    { header: 'CREDENTIAL', value: credentialCell },
    { header: 'MIRROR', value: mirrorCell },
  ]);
}

/**
 * Listing with the mirror's measurements: size on disk and indexed messages.
 */
export function renderAccountStatus(entries: readonly AccountOverview[]): string {
  return table(entries, [
    { header: 'ID', value: (entry) => colors.bold(entry.account.id) },
    { header: 'MIRROR', value: mirrorCell },
    { header: 'ON DISK', value: (entry) => formatBytes(entry.stats?.sizeBytes), align: 'right' },
    { header: 'MESSAGES', value: (entry) => formatCount(entry.stats?.indexedMessages), align: 'right' },
    { header: 'UNREAD', value: (entry) => formatCount(entry.stats?.unreadMessages), align: 'right' },
  ]);
}

/**
 * Detail view of a single account.
 */
export function renderAccountDetail(entry: AccountOverview): string {
  const { account } = entry;

  const rows: (readonly [string, string])[] = [
    ['id', colors.bold(account.id)],
    ['sender name', account.label],
    ['address', account.address],
    ['imap', `${account.imap.host}:${account.imap.port} (${account.imap.user})`],
    ['smtp', `${account.smtp.host}:${account.smtp.port} (${account.smtp.user ?? account.imap.user})`],
    ['credential', credentialCell(entry)],
    ['mirror', mirrorCell(entry)],
  ];

  if (entry.stats !== undefined) {
    rows.push(
      ['mirror path', entry.stats.exists ? entry.stats.path : colors.dim(`${entry.stats.path} (absent)`)],
      ['on disk', formatBytes(entry.stats.sizeBytes)],
      ['indexed messages', formatCount(entry.stats.indexedMessages)],
      ['unread', formatCount(entry.stats.unreadMessages)],
    );
  }

  const overrides = Object.entries(account.folders);

  if (overrides.length > 0) {
    rows.push(['declared folders', overrides.map(([key, value]) => `${key} → ${value}`).join(', ')]);
  }

  return definitionList(rows);
}

/**
 * Outcome of a connection test.
 */
export function renderHealth(health: AccountHealth): string {
  const rows: (readonly [string, string])[] = [
    ['credential', health.credential === 'ok' ? badge('present', 'ok') : badge('missing', 'fail')],
    ['imap', probeCell(health.imap)],
    ['smtp', probeCell(health.smtp)],
  ];

  if (health.folderCount !== undefined) {
    rows.push(['folders seen', formatCount(health.folderCount)]);
  }

  // The two probes often share the same reason (typically a missing credential): repeating it
  // verbatim twice is noise, so it is collapsed by naming the probes involved.
  const failures = ([['imap', health.imap], ['smtp', health.smtp]] as const)
    .filter(([, probe]) => probe.detail !== undefined && probe.status !== 'ok');

  const grouped = new Map<string, string[]>();

  for (const [name, probe] of failures) {
    const reason = probe.detail ?? '';

    grouped.set(reason, [...(grouped.get(reason) ?? []), name]);
  }

  const detail = grouped.size === 0
    ? ''
    : `\n\n${[...grouped.entries()]
      .map(([reason, names]) => `  ${colors.red('→')} ${names.join(' and ')}: ${reason}`)
      .join('\n')}`;

  return `${definitionList(rows)}${detail}`;
}

/**
 * Overall tone of a test, to decide how the command should close.
 */
export function summarizeHealth(health: AccountHealth): StatusTone {
  if (health.credential !== 'ok' || health.imap.status === 'failed') {
    return 'fail';
  }

  return health.smtp.status === 'failed' ? 'warn' : 'ok';
}
