import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/* --------
 * Constants
 * -------- */

const LAUNCHCTL_BIN = '/bin/launchctl';

const COMMAND_TIMEOUT_MS = 20_000;

const execFileAsync = promisify(execFile);

/* --------
 * Implementation
 * -------- */

/**
 * The `gui/<uid>` domain, which is where a per-user LaunchAgent lives. A `system/` agent would need
 * root and would run outside the user session, with no access to their Keychain.
 */
export function resolveGuiTarget(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/**
 * Runs `launchctl`, returning its output and exit code rather than throwing.
 *
 * A non-zero exit is ordinary here — `print` on an agent that is not loaded is how absence is
 * detected — so the caller decides what counts as an error.
 */
export async function runLaunchctl(args: readonly string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(LAUNCHCTL_BIN, [...args], {
      timeout:   COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });

    return { stdout, code: 0 };
  } catch (cause) {
    const code = typeof (cause as { code?: unknown }).code === 'number' ? (cause as { code: number }).code : 1;
    const stdout = typeof (cause as { stdout?: unknown }).stdout === 'string' ? (cause as { stdout: string }).stdout : '';

    return { stdout, code };
  }
}
