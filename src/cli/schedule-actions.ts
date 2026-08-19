import { loadOverview } from './overview.js';
import { askConfirm, prompts, required } from './prompt-helpers.js';
import { badge, colors, definitionList, formatBytes, formatPath, heading } from './ui.js';

import {
  installAgent,
  readAgentLogs,
  readAgentStatus,
  triggerAgentNow,
  uninstallAgent,
} from '#schedule/agent';

import type { AgentStatus } from '#schedule/agent';

/* --------
 * Constants
 * -------- */

const INTERVAL_CHOICES = [15, 30, 60, 180, 360] as const;

const DEFAULT_INTERVAL_MINUTES = 30;

const LOG_TAIL_LINES = 20;

/* --------
 * Views
 * -------- */

function describeInterval(minutes: number | undefined): string {
  if (minutes === undefined) {
    return colors.dim('n/a');
  }

  if (minutes < 60) {
    return `every ${minutes} minutes`;
  }

  const hours = minutes / 60;

  return hours === 1 ? 'every hour' : `every ${hours % 1 === 0 ? hours : hours.toFixed(1)} hours`;
}

function renderStatus(status: AgentStatus): string {
  if (!status.installed) {
    return definitionList([['state', badge('not enabled', 'muted')]]);
  }

  const rows: (readonly [string, string])[] = [
    ['state', status.loaded ? badge('enabled', 'ok') : badge('installed but not loaded', 'warn')],
    ['cadence', describeInterval(status.intervalMinutes)],
    [
      'accounts',
      status.accountIds === undefined || status.accountIds.length === 0
        ? 'all accounts with the mirror enabled'
        : status.accountIds.join(', '),
    ],
  ];

  if (status.runningPid !== undefined) {
    rows.push(['running', `yes, pid ${status.runningPid}`]);
  }

  if (status.lastExitCode !== undefined) {
    rows.push([
      'last outcome',
      status.lastExitCode === 0 ? badge('ok', 'ok') : badge(`exited with code ${status.lastExitCode}`, 'fail'),
    ]);
  }

  rows.push(
    ['name in System Settings', status.displayName],
    ['log', formatPath(status.logPath)],
    ['definition', formatPath(status.plistPath)],
  );

  /*
   * An agent installed before the bundle launches Node directly, and macOS attributes it to
   * "Node.js Foundation" in System Settings. It works, but it is unreadable for somebody deciding
   * whether to switch it off: report it with the remedy.
   */
  if (status.usesLegacyDirectNode) {
    rows.push([
      'needs updating',
      colors.yellow('shows up in System Settings as a Node.js Foundation item — run `schedule enable` again'),
    ]);
  }

  /*
   * Node under nvm lives in a directory that contains the version number: upgrading Node moves the
   * binary and the agent silently stops running. It is the most likely way this automation breaks, so
   * it gets checked and reported.
   */
  if (status.nodePathValid === false) {
    rows.push([
      'problem',
      colors.red(`the configured Node no longer exists (${formatPath(status.nodePath ?? '')}) — re-enable the scheduled sync`),
    ]);
  }

  return definitionList(rows);
}

/* --------
 * Actions
 * -------- */

export async function showScheduleStatus(): Promise<void> {
  const status = await readAgentStatus();

  prompts.log.message(`${heading('Scheduled sync')}\n\n${renderStatus(status)}`);

  if (!status.installed) {
    prompts.note('mailbridge schedule enable', 'To enable it');
  }
}

export interface EnableScheduleOptions {
  /** Cadence in minutes. Asked for when absent. */
  intervalMinutes?: number | undefined;
  /** Accounts to sync. Empty array = all. Asked for when absent. */
  accountIds?: readonly string[] | undefined;
}

/**
 * Enables or reconfigures the scheduled sync.
 *
 * With the options provided it asks nothing: that is what scripts need, and what reconfiguring without
 * retyping earlier choices needs.
 */
export async function enableSchedule(options: EnableScheduleOptions = {}): Promise<void> {
  const entries = await loadOverview();
  const mirrored = entries.filter((entry) => entry.account.mirror.enabled);

  if (mirrored.length === 0) {
    prompts.log.warn('No account has the mirror enabled: there would be nothing to sync.');

    return;
  }

  const existing = await readAgentStatus();

  if (existing.installed) {
    prompts.log.info(`The scheduled sync is already enabled, ${describeInterval(existing.intervalMinutes)}. Reconfiguring it.`);
  }

  // ---- Non-interactive path
  if (options.intervalMinutes !== undefined && options.accountIds !== undefined) {
    const unknown = options.accountIds.filter((accountId) => (
      !mirrored.some((entry) => entry.account.id === accountId)
    ));

    if (unknown.length > 0) {
      prompts.log.error(`Accounts without the mirror enabled: ${unknown.join(', ')}.`);
      process.exitCode = 1;

      return;
    }

    const status = await installAgent({
      intervalMinutes: options.intervalMinutes,
      accountIds:      options.accountIds,
    });

    prompts.log.success(`Scheduled sync enabled: ${describeInterval(options.intervalMinutes)}.`);
    prompts.log.message(renderStatus(status));

    return;
  }

  // ---- Interval
  const intervalMinutes = options.intervalMinutes ?? required(await prompts.select({
    message: 'How often should it sync?',
    options: INTERVAL_CHOICES.map((minutes) => ({
      value: minutes,
      label: describeInterval(minutes),
      ...(minutes === DEFAULT_INTERVAL_MINUTES ? { hint: 'recommended' } : {}),
    })),
    initialValue: existing.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
  }));

  // ---- Scope
  const syncAll = options.accountIds === undefined
    ? await askConfirm('Sync every account with the mirror enabled?', true)
    : options.accountIds.length === 0;

  let accountIds: string[] = options.accountIds === undefined ? [] : [...options.accountIds];

  if (!syncAll && options.accountIds === undefined) {
    accountIds = [...required(await prompts.multiselect({
      message: 'Which accounts?',
      options: mirrored.map((entry) => ({
        value: entry.account.id,
        label: entry.account.id,
        hint:  formatBytes(entry.stats?.sizeBytes),
      })),
      initialValues: mirrored.map((entry) => entry.account.id),
      required:      true,
    }))];
  }

  const status = await installAgent({ intervalMinutes, accountIds });

  prompts.log.success(`Scheduled sync enabled: ${describeInterval(intervalMinutes)}.`);
  prompts.log.message(renderStatus(status));

  /*
   * The first run happens after one interval, not immediately: at login the machine is starting
   * everything up and a multi-gigabyte sync is not the priority. Say so, or it looks broken.
   */
  prompts.log.info([
    `The first run happens within ${intervalMinutes} minutes.`,
    'To try it right now: `mailbridge schedule run`.',
  ].join('\n  '));

  prompts.log.warn([
    'If the scheduled sync does not start and the logs show a credential error, the Keychain is asking',
    'for confirmation from a process that cannot answer you: store the password again with',
    '`mailbridge account edit <id>` → The password only, which registers the item authorizing `security`',
    'to read it back without a prompt.',
  ].join(' '));
}

export async function disableSchedule(): Promise<void> {
  const status = await readAgentStatus();

  if (!status.installed) {
    prompts.log.info('The scheduled sync is not enabled: nothing to disable.');

    return;
  }

  if (!(await askConfirm('Disable the scheduled sync?', true))) {
    prompts.log.info('Cancelled.');

    return;
  }

  await uninstallAgent();

  prompts.log.success('Scheduled sync disabled.');
  prompts.log.info([
    `The logs stay in ${formatPath(status.logPath)}: I am not touching them.`,
    `The ${status.displayName} entry disappears from System Settings.`,
  ].join('\n  '));
}

/**
 * Runs right now what the agent would run, in the agent's own environment.
 *
 * This is the check that counts: the agent runs with a different PATH and a different Keychain access
 * than the terminal, so "it works by hand" does not prove it will work on its own.
 */
export async function runScheduleNow(): Promise<void> {
  const status = await readAgentStatus();

  if (!status.installed) {
    prompts.log.warn('The scheduled sync is not enabled.');
    prompts.note('mailbridge schedule enable', 'To enable it');

    return;
  }

  await triggerAgentNow();

  prompts.log.success('Run started by launchd.');
  prompts.log.info([
    'It runs in the background: follow the outcome with `mailbridge schedule logs`.',
    `Log: ${formatPath(status.logPath)}`,
  ].join('\n  '));
}

export async function showScheduleLogs(): Promise<void> {
  const logs = await readAgentLogs(LOG_TAIL_LINES);
  const withContent = logs.filter((entry) => entry.content.length > 0);

  if (withContent.length === 0) {
    prompts.log.info('No logs: the agent has not run yet.');
    prompts.note('mailbridge schedule run', 'To try it now');

    return;
  }

  for (const entry of withContent) {
    prompts.log.message([
      `${heading(formatPath(entry.path))} ${colors.dim(`(${formatBytes(entry.sizeBytes)})`)}`,
      '',
      entry.content.split('\n').map((line) => `  ${line}`).join('\n'),
    ].join('\n'));
  }
}
