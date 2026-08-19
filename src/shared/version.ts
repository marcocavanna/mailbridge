import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* --------
 * Internal state
 * -------- */

/**
 * Read once, synchronously, at module load.
 *
 * Synchronous because the version is needed before anything asynchronous starts — the CLI banner, the MCP
 * handshake — and reading a few hundred bytes once is not worth an await in every caller.
 */
function readVersion(): string {
  /*
   * `src/shared/` and `dist/shared/` are both two levels below the package root, so the same relative
   * path works whether this runs from sources through tsx or from the compiled output. npm always ships
   * `package.json`, so it is there in an installed package too.
   */
  const manifestUrl = new URL('../../package.json', import.meta.url);

  try {
    const raw = readFileSync(fileURLToPath(manifestUrl), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };

    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    /*
     * A missing manifest must not stop the program: the version is informational everywhere it is used.
     * `0.0.0` is a value that sorts below any real release, so an update check treats it as "outdated"
     * rather than claiming to be current.
     */
    return '0.0.0';
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * The package version, from `package.json`.
 *
 * There is one source of truth on purpose: it used to be copied into the CLI banner, the MCP handshake and
 * the LaunchAgent bundle, three places that can drift apart and where nothing would notice.
 */
export const VERSION: string = readVersion();
