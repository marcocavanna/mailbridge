import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfigPath } from '#config/load-accounts';
import { logger } from '#shared/logger';
import { VERSION } from '#shared/version';

/* --------
 * Constants
 * -------- */

const REGISTRY_URL = 'https://registry.npmjs.org/mailbridge/latest';

/**
 * Abbreviated registry document: a few kilobytes instead of the full packument, which for a package with
 * many releases is megabytes.
 */
const REGISTRY_ACCEPT = 'application/vnd.npm.install-v1+json';

/** The network call never delays a command by more than this. */
const FETCH_TIMEOUT_MS = 2_000;

/** How long a check is trusted before asking the registry again. */
const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How long the outro waits for an in-flight check. It is short on purpose: the point of waiting at all is
 * to let the cache land for next time, not to hold up the command.
 */
const SETTLE_TIMEOUT_MS = 500;

/* --------
 * Types
 * -------- */

export type InstallKind = 'npm-global' | 'source' | 'unknown';

interface UpdateState {
  lastCheckedAt: string;
  latestVersion: string | undefined;
}

/* --------
 * Version comparison
 * -------- */

/**
 * Compares two semver-ish versions: negative when `left` is older, positive when newer, zero when equal.
 *
 * Written here rather than pulled in as a dependency: this needs to order `x.y.z` and treat a pre-release
 * as older than its release, which is a dozen lines. A pre-release suffix is compared as a string only
 * when the numeric parts are equal.
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

  // A release outranks its own pre-releases: 1.0.0 is newer than 1.0.0-rc.1.
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
 * Telling somebody who cloned the repository to run `npm install -g` is worse than saying nothing: it
 * would install a second copy alongside their checkout.
 */
export async function resolveInstallKind(): Promise<InstallKind> {
  const here = fileURLToPath(new URL('.', import.meta.url));

  if (here.includes(`${join('node_modules', 'mailbridge')}`)) {
    return 'npm-global';
  }

  try {
    await access(join(here, '..', '..', '.git'));

    return 'source';
  } catch {
    return 'unknown';
  }
}

/* --------
 * State
 * -------- */

function resolveStatePath(): string {
  return join(dirname(resolveConfigPath()), 'update-check.json');
}

async function readState(): Promise<UpdateState | undefined> {
  try {
    return JSON.parse(await readFile(resolveStatePath(), 'utf8')) as UpdateState;
  } catch {
    return undefined;
  }
}

async function writeState(state: UpdateState): Promise<void> {
  const path = resolveStatePath();

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/* --------
 * Implementation
 * -------- */

/**
 * Is the check allowed to run at all?
 *
 * It reaches out to a third party over the network, from a program that reads mail. That is a decision the
 * user has to be able to reverse, so it honours `MAILBRIDGE_NO_UPDATE_CHECK`, the conventional
 * `NO_UPDATE_NOTIFIER`, and stays quiet in CI, where nobody reads an upgrade hint.
 */
export function isUpdateCheckEnabled(): boolean {
  const disabled = process.env['MAILBRIDGE_NO_UPDATE_CHECK'] ?? process.env['NO_UPDATE_NOTIFIER'];

  return !(disabled !== undefined && disabled !== '' && disabled !== '0') && process.env['CI'] === undefined;
}

async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(REGISTRY_URL, {
      signal:  controller.signal,
      headers: { accept: REGISTRY_ACCEPT },
    });

    /*
     * A 404 means the package is not published under this name — a fork, or a version built from source
     * before the first release. That is not a failure and must not produce a warning.
     */
    if (!response.ok) {
      return undefined;
    }

    const parsed = await response.json() as { version?: unknown };

    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    // Offline, timed out, DNS failure: all of them mean "no answer", none of them are worth reporting.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts a version check without blocking, and returns a handle that produces the notice if one is due.
 *
 * The shape is deliberate. The check runs while the command does its real work, and is collected at the
 * end, so it never adds latency to what the user asked for. If the answer has not arrived by then, the
 * command finishes silently and the cache lands for next time.
 *
 * Callers must only use this on interactive paths. It must never run under `serve`, where stdout carries
 * the MCP protocol, nor under `sync --quiet`, whose output is a log file the LaunchAgent writes every few
 * minutes.
 */
export function startUpdateCheck(): { collect: () => Promise<string | undefined> } {
  if (!isUpdateCheckEnabled()) {
    return { collect: async () => undefined };
  }

  const pending = (async (): Promise<string | undefined> => {
    const state = await readState();
    const age = state === undefined ? Number.POSITIVE_INFINITY : Date.now() - new Date(state.lastCheckedAt).getTime();

    // ---- Cached answer still fresh
    if (age < CHECK_INTERVAL_MS) {
      return state?.latestVersion;
    }

    const latest = await fetchLatestVersion();

    await writeState({ lastCheckedAt: new Date().toISOString(), latestVersion: latest }).catch(() => undefined);

    return latest;
  })().catch((cause: unknown) => {
    logger.debug('update check failed', { error: cause });

    return undefined;
  });

  return {
    collect: async () => {
      const latest = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), SETTLE_TIMEOUT_MS);

          // Do not let the timer hold the process open once everything else is done.
          timer.unref?.();
        }),
      ]);

      if (latest === undefined || compareVersions(latest, VERSION) <= 0) {
        return undefined;
      }

      const kind = await resolveInstallKind();

      const instruction = kind === 'source'
        ? 'git pull && pnpm install && pnpm build'
        : 'npm install -g mailbridge';

      return `Update available: ${VERSION} → ${latest} · ${instruction}`;
    },
  };
}
