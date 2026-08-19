import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_DISPLAY_NAME,
  readBundleNodePath,
  removeAppBundle,
  resolveBundleExecutablePath,
  writeAppBundle,
} from './app-bundle.js';
import { resolveGuiTarget, runLaunchctl } from './launchctl.js';
import { AGENT_LABEL, buildAgentPlist, resolveAgentPlistPath, resolveLogDirectory } from './plist.js';

import { MailbridgeError } from '#shared/errors';
import { logger } from '#shared/logger';

/* --------
 * Constants
 * -------- */

/** Version baked into the bundle. */
const AGENT_VERSION = '0.1.0';

/* --------
 * Types
 * -------- */

export interface AgentStatus {
  installed: boolean;
  plistPath: string;
  /** Loaded into launchd: installed but not loaded means it will not run. */
  loaded: boolean;
  intervalMinutes: number | undefined;
  accountIds: readonly string[] | undefined;
  /** Last exit status reported by launchd. 0 = ok. */
  lastExitCode: number | undefined;
  /** PID if it is running right now. */
  runningPid: number | undefined;
  logPath: string;
  errorLogPath: string;
  /** Does the Node binary in use still exist? With nvm it changes with every version. */
  nodePathValid: boolean | undefined;
  nodePath: string | undefined;
  /** The name macOS shows in System Settings. */
  displayName: string;
  /**
   * `true` when the installed agent launches Node directly, without the bundle: an installation made
   * by an earlier version, which shows up in System Settings as an item from Node.js Foundation.
   */
  usesLegacyDirectNode: boolean;
}

export interface InstallAgentOptions {
  intervalMinutes: number;
  accountIds: readonly string[];
}

/* --------
 * Helpers
 * -------- */

/**
 * Path of `dist/cli/main.js`, derived from where this module is running.
 *
 * It is neither guessed nor taken from `process.argv`: the agent has to point at the compiled file,
 * even when the installation was launched from sources through tsx.
 */
function resolveEntryPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));

  // `dist/schedule/` → `dist/cli/main.js`; from `src/schedule/` it still points at dist.
  return join(here, '..', 'cli', 'main.js').replace(`${join('src', 'schedule')}`, join('dist', 'schedule'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts from the installed plist the information needed to explain what the agent will do.
 */
function parseInstalledPlist(content: string): {
  intervalMinutes: number | undefined;
  accountIds: string[];
  executablePath: string | undefined;
} {
  const intervalMatch = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(content);
  const argumentsMatch = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content);

  const argumentValues = argumentsMatch === null
    ? []
    : [...argumentsMatch[1]?.matchAll(/<string>([\s\S]*?)<\/string>/g) ?? []].map((match) => match[1] ?? '');

  const syncIndex = argumentValues.indexOf('sync');

  const accountIds = syncIndex === -1
    ? []
    : argumentValues.slice(syncIndex + 1).filter((value) => !value.startsWith('--'));

  const interval = intervalMatch?.[1];

  return {
    intervalMinutes: interval === undefined ? undefined : Math.round(Number.parseInt(interval, 10) / 60),
    accountIds,
    executablePath:  argumentValues[0],
  };
}

/* --------
 * Implementation
 * -------- */

export function resolveLogPaths(): { logPath: string; errorLogPath: string } {
  const directory = resolveLogDirectory();

  return {
    logPath:      join(directory, 'sync.log'),
    errorLogPath: join(directory, 'sync.error.log'),
  };
}

/**
 * State of the scheduled sync: installed, loaded, at what cadence, with what outcome.
 */
export async function readAgentStatus(): Promise<AgentStatus> {
  const plistPath = resolveAgentPlistPath();
  const { logPath, errorLogPath } = resolveLogPaths();

  const installed = await exists(plistPath);

  if (!installed) {
    return {
      installed:            false,
      plistPath,
      loaded:               false,
      intervalMinutes:      undefined,
      accountIds:           undefined,
      lastExitCode:         undefined,
      runningPid:           undefined,
      logPath,
      errorLogPath,
      nodePathValid:        undefined,
      nodePath:             undefined,
      displayName:          BUNDLE_DISPLAY_NAME,
      usesLegacyDirectNode: false,
    };
  }

  // ---- Declared configuration
  const declared = parseInstalledPlist(await readFile(plistPath, 'utf8'));

  // ---- Runtime state
  const { stdout, code } = await runLaunchctl(['print', `${resolveGuiTarget()}/${AGENT_LABEL}`]);
  const loaded = code === 0;

  const pidMatch = /\bpid = (\d+)/.exec(stdout);
  const exitMatch = /last exit code = (\d+)/.exec(stdout);

  /*
   * The Node in use lives in the bundle's script, not in the plist: the plist points at the bundle. If
   * `ProgramArguments[0]` is a Node binary instead, the agent was installed by an earlier version.
   */
  const launched = declared.executablePath;
  const usesLegacyDirectNode = launched !== undefined && launched !== resolveBundleExecutablePath();
  const nodePath = usesLegacyDirectNode ? launched : await readBundleNodePath();

  return {
    installed:       true,
    plistPath,
    loaded,
    intervalMinutes: declared.intervalMinutes,
    accountIds:      declared.accountIds,
    lastExitCode:    exitMatch?.[1] === undefined ? undefined : Number.parseInt(exitMatch[1], 10),
    runningPid:      pidMatch?.[1] === undefined ? undefined : Number.parseInt(pidMatch[1], 10),
    logPath,
    errorLogPath,
    nodePath,
    nodePathValid:   nodePath === undefined ? undefined : await exists(nodePath),
    displayName:     BUNDLE_DISPLAY_NAME,
    usesLegacyDirectNode,
  };
}

/**
 * Installs (or reconfigures) the LaunchAgent and loads it.
 *
 * `bootout` before `bootstrap`: launchd refuses to load a Label that is already present, and
 * reconfiguring without unloading would leave the old interval in force.
 */
export async function installAgent(options: InstallAgentOptions): Promise<AgentStatus> {
  const plistPath = resolveAgentPlistPath();
  const { logPath, errorLogPath } = resolveLogPaths();
  const entryPath = resolveEntryPath();

  if (!(await exists(entryPath))) {
    throw new MailbridgeError('config_invalid', `Cannot find the compiled CLI at ${entryPath}.`, {
      remediation: 'Run `pnpm build` and try again.',
    });
  }

  // ---- Bundle: gives the agent an identity of its own in System Settings
  const executablePath = await writeAppBundle({
    nodePath:  process.execPath,
    entryPath,
    version:   AGENT_VERSION,
  });

  // ---- Write plist
  const content = buildAgentPlist({
    executablePath,
    intervalMinutes: options.intervalMinutes,
    accountIds:      options.accountIds,
    logPath,
    errorLogPath,
  });

  await mkdir(resolveLogDirectory(), { recursive: true });
  await mkdir(join(plistPath, '..'), { recursive: true });
  await writeFile(plistPath, content, { encoding: 'utf8', mode: 0o644 });

  // ---- Reload
  const target = resolveGuiTarget();

  await runLaunchctl(['bootout', `${target}/${AGENT_LABEL}`]);

  const { stdout, code } = await runLaunchctl(['bootstrap', target, plistPath]);

  if (code !== 0) {
    throw new MailbridgeError('config_invalid', `launchd refused the agent: ${stdout.trim() || `code ${code}`}.`, {
      remediation: `Inspect the file at ${plistPath}.`,
    });
  }

  logger.info('LaunchAgent installed', {
    intervalMinutes: options.intervalMinutes,
    accounts:        options.accountIds.length === 0 ? 'all' : options.accountIds.join(','),
  });

  return readAgentStatus();
}

/**
 * Unloads and removes the LaunchAgent. The logs stay: they are what explains what happened.
 */
export async function uninstallAgent(): Promise<void> {
  const plistPath = resolveAgentPlistPath();

  await runLaunchctl(['bootout', `${resolveGuiTarget()}/${AGENT_LABEL}`]);
  await rm(plistPath, { force: true });
  await removeAppBundle();

  logger.info('LaunchAgent removed');
}

/**
 * Forces an immediate run, without waiting for the interval. It proves the agent really works in its
 * own environment, which is not the terminal's.
 */
export async function triggerAgentNow(): Promise<void> {
  const { stdout, code } = await runLaunchctl(['kickstart', '-k', `${resolveGuiTarget()}/${AGENT_LABEL}`]);

  if (code !== 0) {
    throw new MailbridgeError('mirror_unavailable', `Cannot start the agent: ${stdout.trim() || `code ${code}`}.`, {
      remediation: 'Check with `mailbridge schedule status` that it is installed and loaded.',
    });
  }
}

/**
 * Last lines of the agent's logs.
 */
export async function readAgentLogs(lines: number): Promise<{ path: string; content: string; sizeBytes: number }[]> {
  const { logPath, errorLogPath } = resolveLogPaths();

  return Promise.all([logPath, errorLogPath].map(async (path) => {
    try {
      const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const tail = raw.trimEnd().split('\n').slice(-lines).join('\n');

      return { path, content: tail, sizeBytes: info.size };
    } catch {
      return { path, content: '', sizeBytes: 0 };
    }
  }));
}
