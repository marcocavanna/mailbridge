import * as prompts from '@clack/prompts';

import { colors } from './ui.js';

/* --------
 * Types
 * -------- */

/**
 * Signals that the user cancelled. Not an error: it travels up to the dispatcher, which exits cleanly
 * without a stack trace.
 */
export class CancelledError extends Error {
  public constructor() {
    super('operation cancelled');
    this.name = 'CancelledError';
  }
}

/* --------
 * Implementation
 * -------- */

/**
 * Guards a clack prompt: any cancellation value becomes a typed throw, so the flows do not have to
 * check `isCancel` on every line.
 */
export function required<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) {
    throw new CancelledError();
  }

  return value;
}

export async function askText(message: string, options: {
  placeholder?: string;
  initialValue?: string;
  validate?: (value: string) => string | undefined;
} = {}): Promise<string> {
  const value = required(await prompts.text({
    message,
    ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
    ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
    validate: (raw) => {
      const trimmed = (raw ?? '').trim();

      if (trimmed.length === 0) {
        return 'A value is required.';
      }

      return options.validate?.(trimmed);
    },
  }));

  return value.trim();
}

export async function askPort(message: string, initialValue: number): Promise<number> {
  const raw = await askText(message, {
    initialValue: String(initialValue),
    validate:     (value) => {
      const parsed = Number.parseInt(value, 10);

      return Number.isNaN(parsed) || parsed < 1 || parsed > 65535 ? 'Not a valid port.' : undefined;
    },
  });

  return Number.parseInt(raw, 10);
}

export async function askConfirm(message: string, initialValue = false): Promise<boolean> {
  return required(await prompts.confirm({ message, initialValue }));
}

/**
 * A reinforced confirmation for irreversible actions: it asks the user to retype an exact string.
 *
 * A `confirm` gets accepted by reflex with a press of Enter; retyping an account id does not.
 */
export async function askTypedConfirmation(message: string, expected: string): Promise<boolean> {
  const value = required(await prompts.text({
    message: `${message} Type ${colors.bold(expected)} to confirm.`,
    validate: () => undefined,
  }));

  return value.trim() === expected;
}

/* --------
 * Spinner
 * -------- */

export interface SpinnerHandle {
  message: (text: string) => void;
}

export interface WithSpinnerOptions<T> {
  /** Closing message on success. */
  successMessage?: (result: T) => string;
  /** Closing message when the action throws. */
  failureMessage?: string;
  /**
   * Distinguishes a successful result from one that made it to the end with problems.
   *
   * It matters because a success glyph on a failed test is wrong information at exactly the point
   * where the eye lands first.
   */
  outcome?: (result: T) => 'ok' | 'problem';
}

/**
 * Runs an operation under a spinner, guaranteeing that it is **always** closed, errors included.
 *
 * A spinner left running while an exception travels up makes clack print a spurious "Canceled" after
 * the real error message — confusing at exactly the moment clarity is needed.
 */
export async function withSpinner<T>(
  startMessage: string,
  action: (handle: SpinnerHandle) => Promise<T>,
  options: WithSpinnerOptions<T> = {},
): Promise<T> {
  const spinner = prompts.spinner();

  spinner.start(startMessage);

  try {
    const result = await action({ message: (text) => spinner.message(text) });
    const closing = options.successMessage?.(result) ?? startMessage;

    if (options.outcome?.(result) === 'problem') {
      spinner.error(closing);
    } else {
      spinner.stop(closing);
    }

    return result;
  } catch (cause) {
    spinner.error(options.failureMessage ?? `${startMessage}: failed`);

    throw cause;
  }
}

export { prompts };
