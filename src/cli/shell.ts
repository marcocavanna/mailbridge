import { prompts } from './prompt-helpers.js';
import { colors } from './ui.js';

/* --------
 * Constants
 * -------- */

export const VERSION = '0.1.0';

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
    renderIntro();

    await action();

    prompts.outro(process.exitCode === undefined || process.exitCode === 0
      ? 'Done.'
      : colors.yellow('Completed with problems.'));
  };
}
