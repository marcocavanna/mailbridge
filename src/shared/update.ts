import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';
import { VERSION } from './version.js';

/* --------
 * Constants
 * -------- */

const REGISTRY_URL = 'https://registry.npmjs.org/mailbridge/latest';

/** Abbreviated registry document: kilobytes instead of the full packument. */
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json';

const FETCH_TIMEOUT_MS = 2_000;

const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/* --------
 * Types
 * -------- */

export type InstallKind = 'npm-global' | 'source' | 'unknown';

export interface UpdateState {
  lastCheckedAt: string;
  latestVersion: string | undefined;
  /** ISO instant until which notices stay silent, set by the user postponing them. */
  suppressedUntil?: string | undefined;
}

export interface UpdateNotice {
  currentVersion: string;
  latestVersion: string;
  installKind: InstallKind;
  /** The command that actually upgrades this particular install. */
  command: string;
}

/* --------
 * Version comparison
 * -------- */

/**
 * Compares two semver-ish versions: negative when `left` is older, positive when newer, zero when equal.
 *
 * Written here rather than pulled in as a dependency: this needs to order `x.y.z` and rank a pre-release
 * below its release, which is a dozen lines. A string comparison would put `1.10.0` below `1.2.0` and tell
 * users on the newer release to downgrade.
 */
export function compareVersions(left: string, right: string): number {
  const split = (value: string): { numbers: number[]; pre: string } => {
    const [core = '', pre = ''] = value.replace(/^v/, '').split('-', 2);

    return {
      numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre,
    };
  };

  const a = split(left);
  const b = split(right);

  for (let index = 0; index < 3; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);

    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }

  if (a.pre === b.pre) {
    return 0;
  }

  if (a.pre === '') {
    return 1;
  }

  if (b.pre === '') {
    return -1;
  }

  return a.pre < b.pre ? -1 : 1;
}

/* --------
 * Install kind
 * -------- */

/**
 * How this copy was installed, which decides what the upgrade instruction should say.
 *
 * Telling somebody who cloned the repository to run `npm install -g` is worse than saying nothing: it would
 * install a second copy alongside their checkout.
 *
 * Synchronous, because the MCP handshake builds its instructions synchronously.
 */
export function resolveInstallKind(): InstallKind {
  const here = fileURLToPath(new URL('.', import.meta.url));

  if (here.includes(join('node_modules', 'mailbridge'))) {
    return 'npm-global';
  }

  try {
    readFileSync(join(here, '..', '..', '.git', 'HEAD'), 'utf8');

    return 'source';
  } catch {
    return 'unknown';
  }
}

export function resolveUpdateCommand(kind: InstallKind): string {
  return kind === 'source' ? 'git pull && pnpm install && pnpm build' : 'npm install -g mailbridge@latest';
}

/* --------
 * State
 * -------- */

function resolveStatePath(): string {
  const override = process.env['MAILBRIDGE_CONFIG'];
  const directory = override !== undefined && override.length > 0
    ? dirname(override)
    : join(process.env['HOME'] ?? '', '.config', 'mailbridge');

  return join(directory, 'update-check.json');
}

export function readUpdateState(): UpdateState | undefined {
  try {
    return JSON.parse(readFileSync(resolveStatePath(), 'utf8')) as UpdateState;
  } catch {
    return undefined;
  }
}

function writeUpdateState(state: UpdateState): void {
  const path = resolveStatePath();

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (cause) {
    logger.debug('could not persist the update state', { error: cause });
  }
}

/* --------
 * Enablement
 * -------- */

/**
 * Is checking allowed at all?
 *
 * It reaches a third party over the network from a program that reads mail, so the user has to be able to
 * refuse: the project variable, the conventional `NO_UPDATE_NOTIFIER`, and silence in CI.
 */
export function isUpdateCheckEnabled(): boolean {
  const disabled = process.env['MAILBRIDGE_NO_UPDATE_CHECK'] ?? process.env['NO_UPDATE_NOTIFIER'];

  return !(disabled !== undefined && disabled !== '' && disabled !== '0') && process.env['CI'] === undefined;
}

/**
 * Silences notices for a number of hours. `0` clears the suppression.
 */
export function suppressUpdateNotices(hours: number): string | undefined {
  const state = readUpdateState() ?? { lastCheckedAt: new Date(0).toISOString(), latestVersion: undefined };

  if (hours <= 0) {
    writeUpdateState({ ...state, suppressedUntil: undefined });

    return undefined;
  }

  const until = new Date(Date.now() + hours * 60 * 60_000).toISOString();

  writeUpdateState({ ...state, suppressedUntil: until });

  return until;
}

/* --------
 * Reading the notice
 * -------- */

/**
 * The pending notice, read from cache **synchronously and without any network call**.
 *
 * That is what makes it usable while building the MCP handshake, which cannot await: the answer comes from
 * whatever the last background refresh stored. A first run with a cold cache reports nothing, and the
 * following one reports it.
 */
export function readPendingNotice(): UpdateNotice | undefined {
  if (!isUpdateCheckEnabled()) {
    return undefined;
  }

  const state = readUpdateState();

  if (state?.latestVersion === undefined) {
    return undefined;
  }

  if (state.suppressedUntil !== undefined && new Date(state.suppressedUntil).getTime() > Date.now()) {
    return undefined;
  }

  if (compareVersions(state.latestVersion, VERSION) <= 0) {
    return undefined;
  }

  const installKind = resolveInstallKind();

  return {
    currentVersion: VERSION,
    latestVersion:  state.latestVersion,
    installKind,
    command:        resolveUpdateCommand(installKind),
  };
}

export function formatNotice(notice: UpdateNotice): string {
  return `mailbridge ${notice.latestVersion} is available (running ${notice.currentVersion}). Upgrade with: ${notice.command}`;
}

/* --------
 * Refreshing
 * -------- */

async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(REGISTRY_URL, { signal: controller.signal, headers: { accept: REGISTRY_ACCEPT } });

    /*
     * A 404 means the package is not published under this name — a fork, or a build from source before the
     * first release. Not a failure, and not worth a warning.
     */
    if (!response.ok) {
      return undefined;
    }

    const parsed = await response.json() as { version?: unknown };

    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    // Offline, DNS failure, timeout: all mean "no answer", none deserve a warning.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refreshes the cached version, at most once per interval. Resolves to `true` when it actually asked the
 * registry.
 *
 * Every caller treats this as fire-and-forget: nothing waits on it to do its real work.
 */
export async function refreshUpdateState(): Promise<boolean> {
  if (!isUpdateCheckEnabled()) {
    return false;
  }

  const state = readUpdateState();
  const age = state === undefined ? Number.POSITIVE_INFINITY : Date.now() - new Date(state.lastCheckedAt).getTime();

  if (age < CHECK_INTERVAL_MS) {
    return false;
  }

  const latest = await fetchLatestVersion();

  writeUpdateState({
    lastCheckedAt: new Date().toISOString(),
    latestVersion: latest,
    ...(state?.suppressedUntil === undefined ? {} : { suppressedUntil: state.suppressedUntil }),
  });

  return true;
}
