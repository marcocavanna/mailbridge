import { homedir } from 'node:os';
import { join } from 'node:path';

/* --------
 * Constants
 * -------- */

/** Reverse-DNS: it is launchd's convention, and the file name has to match the Label. */
export const AGENT_LABEL = 'com.marcocavanna.mailbridge.sync';

/**
 * launchd starts processes with a minimal environment: `mbsync` and `notmuch` live in
 * `/opt/homebrew/bin`, which is not on the default PATH. Without this the sync fails with
 * "command not found" and the logs do not make the cause obvious.
 */
const AGENT_PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/* --------
 * Types
 * -------- */

export interface AgentConfig {
  /**
   * The executable launchd starts: the bundle's executable, **not** the Node binary.
   *
   * In System Settings a background item is attributed to whoever signs the executable that was
   * launched. Pointing at Node, macOS announces "an item from Node.js Foundation" — true, and useless
   * to somebody deciding whether to turn it off. See `app-bundle.ts`.
   */
  executablePath: string;
  /** How many minutes between syncs. */
  intervalMinutes: number;
  /** Accounts to sync. Empty = all of them. */
  accountIds: readonly string[];
  logPath: string;
  errorLogPath: string;
}

/* --------
 * Helpers
 * -------- */

export function resolveAgentPlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

export function resolveLogDirectory(): string {
  return join(homedir(), 'Library', 'Logs', 'mailbridge');
}

/**
 * XML escaping for the values that end up in the plist. Paths can contain `&` and quotes, and a
 * malformed plist is rejected by launchd with an error that does not say which character broke it.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stringEntry(value: string): string {
  return `    <string>${escapeXml(value)}</string>`;
}

/* --------
 * Implementation
 * -------- */

/**
 * Generates the `plist` of the LaunchAgent that runs the sync on an interval.
 *
 * Non-obvious choices, all deliberate:
 *
 * - `StartInterval` rather than `StartCalendarInterval`: what matters is the *frequency*, not a
 *   precise time of day. If the Mac sleeps, launchd does not wake it and catches up on wake — which is
 *   the intended behaviour: waking a laptop to fetch mail burns battery for nothing.
 * - `RunAtLoad` is `false`: at login everything is starting up, and a multi-gigabyte sync is not the
 *   first thing anybody needs. The first run happens after one interval.
 * - `--quiet` because the output goes to a log file, not a terminal: without it the logs fill up with
 *   control sequences from colours and the spinner.
 * - `LowPriorityIO` and `Nice`: the sync must not make the machine feel slower while you work.
 */
export function buildAgentPlist(config: AgentConfig): string {
  const programArguments = [
    config.executablePath,
    'sync',
    ...(config.accountIds.length === 0 ? ['--all'] : config.accountIds),
    '--quiet',
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(AGENT_LABEL)}</string>`,
    '',
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((argument) => stringEntry(argument)),
    '  </array>',
    '',
    '  <key>StartInterval</key>',
    `  <integer>${config.intervalMinutes * 60}</integer>`,
    '',
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${escapeXml(AGENT_PATH)}</string>`,
    /*
     * The logger writes to stderr, which launchd sends to `sync.error.log`. At `info` level that file
     * would fill up with lines that are not errors, and would stop being a signal: if there is
     * something in there, it has to mean something went wrong. The normal report goes to stdout, in
     * `sync.log`.
     */
    '    <key>MAILBRIDGE_LOG_LEVEL</key>',
    '    <string>warn</string>',
    '  </dict>',
    '',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(config.logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(config.errorLogPath)}</string>`,
    '',
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    '  <key>Nice</key>',
    '  <integer>5</integer>',
    '',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
