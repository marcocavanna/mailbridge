import { formatNotice, isUpdateCheckEnabled, readPendingNotice, refreshUpdateState } from '#shared/update';

/* --------
 * Constants
 * -------- */

/**
 * How long the outro waits for an in-flight refresh. Short on purpose: the point of waiting at all is to
 * let the cache land for next time, not to hold up the command.
 */
const SETTLE_TIMEOUT_MS = 500;

/* --------
 * Implementation
 * -------- */

/**
 * Starts a refresh without blocking, and returns a handle that produces the notice if one is due.
 *
 * The shape is deliberate: the request runs while the command does its real work and is collected at the
 * end, so it never adds latency. If the answer has not arrived by then the command finishes silently and
 * the cache serves the next run.
 *
 * Only for interactive paths. Never under `serve`, where stdout carries the MCP protocol, nor under
 * `sync --quiet`, whose output is a log file the scheduled agent appends to.
 */
export function startUpdateCheck(): { collect: () => Promise<string | undefined> } {
  if (!isUpdateCheckEnabled()) {
    return { collect: async () => undefined };
  }

  const pending = refreshUpdateState().catch(() => false);

  return {
    collect: async () => {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);

          // Do not let the timer hold the process open once everything else is done.
          timer.unref?.();
        }),
      ]);

      const notice = readPendingNotice();

      return notice === undefined ? undefined : formatNotice(notice);
    },
  };
}
