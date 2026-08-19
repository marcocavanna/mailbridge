import { prompts } from './prompt-helpers.js';
import { startUpdateCheck } from './update-check.js';
import { colors } from './ui.js';

import { VERSION } from '#shared/version';

export { VERSION };

/* --------
 * Implementation
 * -------- */

export function renderIntro(): void {
  prompts.intro(`${colors.bgCyan(colors.black(' mailbridge '))} ${colors.dim(VERSION)}`);
}

/**
 * Wraps a non-interactive action with intro/outro, so its output has the same shape as the menu's.
 *
 * The closing line reflects the outcome: an action that set `exitCode` does not close with "Done.",
 * which would contradict the exit code handed back to the shell.
 */
export function framed(action: () => Promise<void>): () => Promise<void> {
  return async () => {
    /*
     * Started before the work and collected after it, so the network call overlaps with what the user
     * actually asked for and never adds latency. Only on this path: `serve` writes the MCP protocol to
     * stdout, and `sync --quiet` writes a log file the scheduled agent appends to every few minutes.
     */
    const updateCheck = startUpdateCheck();

    renderIntro();

    await action();

    const notice = await updateCheck.collect();

    if (notice !== undefined) {
      prompts.log.info(colors.dim(notice));
    }

    prompts.outro(process.exitCode === undefined || process.exitCode === 0
      ? 'Done.'
      : colors.yellow('Completed with problems.'));
  };
}
