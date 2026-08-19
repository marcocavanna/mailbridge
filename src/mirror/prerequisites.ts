import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { MailbridgeError } from '#shared/errors';

/* --------
 * Constants
 * -------- */

const PROBE_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

/* --------
 * Types
 * -------- */

export interface MirrorTool {
  binary: 'mbsync' | 'notmuch';
  /** Homebrew formula that provides it — not always the same as the binary name. */
  formula: string;
  available: boolean;
}

/* --------
 * Helpers
 * -------- */

async function isOnPath(binary: string, versionFlag: string): Promise<boolean> {
  try {
    await execFileAsync(binary, [versionFlag], { timeout: PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 });

    return true;
  } catch (cause) {
    /*
     * A missing binary raises ENOENT. Anything else — a non-zero exit, an unrecognized flag — means the
     * program is there and answered, which is all this check needs to know.
     */
    return (cause as { code?: unknown }).code !== 'ENOENT';
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * Which of the mirror's external tools are present.
 *
 * `mbsync` ships in the `isync` formula, which is the kind of mismatch that makes a "command not found"
 * message useless on its own.
 */
export async function checkMirrorTools(): Promise<MirrorTool[]> {
  const [mbsync, notmuch] = await Promise.all([
    isOnPath('mbsync', '--version'),
    isOnPath('notmuch', '--version'),
  ]);

  return [
    { binary: 'mbsync', formula: 'isync', available: mbsync },
    { binary: 'notmuch', formula: 'notmuch', available: notmuch },
  ];
}

/**
 * Fails with an actionable message when the mirror's tools are missing.
 *
 * It runs before any work starts, because the alternative is what used to happen: three `spawn mbsync
 * ENOENT` warnings followed by a final error blaming notmuch, which sends the reader after the wrong
 * problem. Anybody installing from npm has neither tool, so this is the first wall they hit.
 */
export async function assertMirrorTools(): Promise<void> {
  const tools = await checkMirrorTools();
  const missing = tools.filter((tool) => !tool.available);

  if (missing.length === 0) {
    return;
  }

  const formulas = [...new Set(missing.map((tool) => tool.formula))].join(' ');
  const names = missing.map((tool) => tool.binary).join(' and ');

  throw new MailbridgeError('mirror_unavailable', `The local mirror needs ${names}, which ${missing.length === 1 ? 'is' : 'are'} not installed.`, {
    remediation: [
      `Install ${missing.length === 1 ? 'it' : 'them'} with \`brew install ${formulas}\`.`,
      'Everything else works without the mirror: search falls back to IMAP and says so.',
    ].join(' '),
  });
}
