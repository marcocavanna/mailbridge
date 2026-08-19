/* --------
 * Types
 * -------- */

/**
 * Domain error codes. A union of string literals, never an enum.
 */
export type MailbridgeErrorCode =
  | 'account_not_found'
  | 'config_invalid'
  | 'config_missing'
  | 'credential_missing'
  | 'folder_not_found'
  | 'imap_connection_failed'
  | 'imap_operation_failed'
  | 'message_not_found'
  | 'mirror_unavailable'
  | 'search_failed'
  | 'send_rejected'
  | 'smtp_send_failed';

export interface MailbridgeErrorOptions {
  /** What the reader must do to get out of this. It reaches the model, so write it to be acted on. */
  remediation?: string;
  /** The original error, kept for the log but never serialized towards the model. */
  cause?: unknown;
}

/* --------
 * Implementation
 * -------- */

/**
 * The only error the modules throw. No `throw new Error('string')` anywhere else.
 */
export class MailbridgeError extends Error {
  public readonly code: MailbridgeErrorCode;

  public readonly remediation: string | undefined;

  public constructor(code: MailbridgeErrorCode, message: string, options: MailbridgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    this.name = 'MailbridgeError';
    this.code = code;
    this.remediation = options.remediation;
  }

  /**
   * Text meant for the model: the problem plus the way out, with no stack and no causes.
   */
  public toAgentMessage(): string {
    return this.remediation === undefined ? this.message : `${this.message} ${this.remediation}`;
  }
}

/* --------
 * Helpers
 * -------- */

export function isMailbridgeError(value: unknown): value is MailbridgeError {
  return value instanceof MailbridgeError;
}

/**
 * Turns anything thrown into a readable message without losing the useful part.
 */
export function describeUnknownError(value: unknown): string {
  if (isMailbridgeError(value)) {
    return value.toAgentMessage();
  }

  if (value instanceof Error) {
    return value.message;
  }

  return String(value);
}
